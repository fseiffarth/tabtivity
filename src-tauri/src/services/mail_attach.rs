//! A root agent's `attach` on a mail draft (`docs/mail_mcp_attachments_plan.md`
//! Phase 1): `{project, path}` pairs resolved under the **same-roots rule** and
//! read without following a link.
//!
//! Tabtivity (the MCP process) is not fenced, so every path an agent names makes
//! Tabtivity read on the agent's behalf. What holds that to the tab's own view:
//!
//! - the caller's session recorded at spawn that its fence shows the projects
//!   (`root_mcp::Session::projects_grant`) — checked by `root_mcp_mail`;
//! - the roots are the ones a fenced tab *of that project* would get
//!   ([`agent_fence::attach_roots`]), minus any at `/`, at or above `$HOME`, or
//!   inside Tabtivity's state (the fence masks those);
//! - the path is checked component by component before any I/O, and opened by
//!   an `openat(O_NOFOLLOW)` walk from the root: a link at any component is
//!   refused, and there is no window between a check and the read;
//! - the final open is `O_NONBLOCK` and `fstat` must say regular file, so a
//!   FIFO cannot hang the handler; the read is capped one byte over the limit.
//!
//! Windows has no fence (a root tab there runs with the user's rights, so its
//! grant is everything) but the same walk: the phone's handle-based
//! `files::ProjectDir` opens one name at a time relative to the held folder
//! with `NtCreateFile(FILE_OPEN_REPARSE_POINT)`, refuses every reparse point
//! (junctions included) from the handle's own metadata, and reads the file
//! through the handle it proved. Names Windows would read as something else —
//! a `:` (drive or stream), an 8.3 short alias, a trailing dot or space — are
//! refused before any I/O (`windows_part_refusal`).
//!
//! The secret-shaped name list below is defence in depth only: a writer in the
//! project copies `.env` to `notes.txt`. The gates that hold are the user's —
//! the agent never sets a recipient, and Send is bound to the reviewed set.
//!
//! `AppHandle`-free and pure over the lists it is handed, so the tests drive it
//! with a temporary tree.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::schema::boxes::BoxesList;
use crate::schema::projects::ProjectsList;

/// Files per draft.
pub const MAX_FILES: usize = 5;
/// Bytes per draft, all its agent files together.
pub const MAX_DRAFT_BYTES: u64 = 25 * 1024 * 1024;
/// Agent-staged bytes per tab across all its drafts: an injected loop must
/// not fill the disk.
pub const MAX_TAB_BYTES: u64 = 100 * 1024 * 1024;

/// The session's spawn record says its fence hides the projects.
pub const NEEDS_PROJECTS_READABLE: &str = concat!("attaching needs a root tab that can read the projects: switch on \"Root agent reads projects\" under Agent sandbox in ", crate::app_name!(), "'s Settings, then start a new root tab");
/// Reader and local-model tabs never attach.
pub const NOT_FOR_CALLER: &str = "`attach` is not available to this agent";

/// One `attach` item as the agent sent it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub project: String,
    pub path: String,
}

/// A file read for staging. The bytes go straight into the sealed outbox copy.
#[derive(Debug, Clone)]
pub struct Resolved {
    pub filename: String,
    pub mime: String,
    /// `<project name>/<relative path>`, shown on the composer's chip.
    pub source: String,
    pub bytes: Vec<u8>,
}

/// What resolution reads from: the trusted lists and where Tabtivity's own
/// state and the user's home are.
pub struct Lists<'a> {
    pub projects: &'a ProjectsList,
    pub boxes: &'a BoxesList,
    pub state_dir: &'a Path,
    pub home: &'a Path,
    /// The project paths the calling tab's fence exposed when it was spawned
    /// (`root_mcp::ProjectsGrant::Paths`); `None` for an unfenced tab, which
    /// already reads everything. A project added after the spawn is in
    /// `projects.json` but not in the tab's sandbox, and Tabtivity never reads
    /// what the tab's fence hides.
    pub granted: Option<&'a [PathBuf]>,
}

const ITEM_SHAPE: &str = "`attach` is a list of {\"project\": id or name, \"path\": path inside that project}";

/// The `attach` argument: `None` when absent (an update then leaves the
/// draft's files alone), `Some(vec![])` for `attach: []` (remove them).
/// `root_mcp_security::validate` ignores `maxItems`, so the cap is here.
pub fn parse(args: &Value) -> Result<Option<Vec<Request>>, String> {
    let items = match args.get("attach") {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Array(items)) => items,
        Some(_) => return Err(ITEM_SHAPE.into()),
    };
    if items.len() > MAX_FILES {
        return Err(format!("at most {MAX_FILES} files per draft"));
    }
    items
        .iter()
        .map(|item| {
            let project = item.get("project").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
            let path = item.get("path").and_then(Value::as_str).filter(|s| !s.is_empty());
            match (project, path) {
                (Some(project), Some(path)) if project.len() <= 200 && path.len() <= 1024 => {
                    Ok(Request { project: project.to_string(), path: path.to_string() })
                }
                _ => Err(ITEM_SHAPE.to_string()),
            }
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

/// `path` as components, refused before any I/O when it could leave the
/// root or reach a repository's internals: empty, `.` and `..` components, a
/// backslash, a NUL, a leading `/`, and any `.git` component.
pub fn components(path: &str) -> Result<Vec<&str>, String> {
    if path.contains('\0') || path.contains('\\') {
        return Err("`path` uses forward slashes only and no control characters".into());
    }
    if path.starts_with('/') {
        return Err("`path` is relative to the project: no leading `/`, no absolute path".into());
    }
    let parts: Vec<&str> = path.split('/').collect();
    if parts.iter().any(|c| c.is_empty() || *c == "." || *c == "..") {
        return Err("`path` may not contain empty, `.` or `..` parts".into());
    }
    if parts.iter().any(|c| c.eq_ignore_ascii_case(".git")) {
        return Err("files inside `.git` are never attached".into());
    }
    if cfg!(windows) {
        if let Some(reason) = parts.iter().find_map(|c| windows_part_refusal(c)) {
            return Err(reason.into());
        }
    }
    Ok(parts)
}

/// Why one component is refused on Windows before any I/O, if it is: a name
/// the filesystem would read as something other than itself. A `:` names a
/// drive or an alternate data stream (`notes.txt:hidden`, `.git::$INDEX_ALLOCATION`);
/// a `~` followed by a digit is the shape of an 8.3 short alias, which opens
/// the long name it stands for (`GIT~1` for `.git`, `ENV~1` for `.env`) past
/// the name checks; a trailing dot or space is dropped by Win32 when the file
/// is made, so such a name is an alias too. Pure, so Linux runs its test.
fn windows_part_refusal(part: &str) -> Option<&'static str> {
    if part.contains(':') {
        return Some("`path` may not contain `:`: on Windows it names a drive or a hidden stream");
    }
    let short_alias = part.as_bytes().windows(2).any(|w| w[0] == b'~' && w[1].is_ascii_digit());
    if short_alias {
        return Some("`path` may not use a Windows short name (`NAME~1`); give the full name");
    }
    if part.ends_with(['.', ' ']) {
        return Some("`path` may not have a part ending in a dot or a space");
    }
    None
}

/// Why a basename is refused as secret-shaped, if it is. Defence in depth
/// only (see the module docs).
pub fn denied_name(name: &str) -> Option<&'static str> {
    let n = name.to_ascii_lowercase();
    let exact = [".netrc", ".npmrc", ".pypirc", ".git-credentials"];
    let prefix = [".env", "id_rsa", "id_ed25519", "id_ecdsa", "credentials"];
    let suffix = [".pem", ".key", ".p12", ".pfx", ".kdbx"];
    if exact.contains(&n.as_str())
        || prefix.iter().any(|p| n.starts_with(p))
        || suffix.iter().any(|s| n.ends_with(s))
        || n.contains("token")
        || n.contains("secret")
    {
        return Some("its name looks like a key, token or credential file");
    }
    None
}

/// A project this root tab's sandbox was not built with (added, or moved,
/// after the tab started).
pub const NOT_IN_GRANT: &str = "that project was not in this tab's view when it started; open a new root tab to attach from it";

/// Whether `root` lies inside a path the tab's fence exposed. `None` is an
/// unfenced tab. Component-wise `starts_with`, so `/w/alpha2` is not inside
/// `/w/alpha`.
fn within_grant(granted: Option<&[PathBuf]>, root: &Path) -> bool {
    granted.is_none_or(|g| g.iter().any(|p| root.starts_with(p)))
}

/// Why a root is not attachable from at all: `/`, `$HOME` or an ancestor of it
/// (the fence shows neither), or a place inside Tabtivity's state (masked).
fn root_refusal(root: &Path, home: &Path, state_dir: &Path) -> Option<&'static str> {
    let forms: Vec<PathBuf> = [Some(root.to_path_buf()), root.canonicalize().ok()].into_iter().flatten().collect();
    let homes: Vec<PathBuf> = [Some(home.to_path_buf()), home.canonicalize().ok()].into_iter().flatten().collect();
    let private = super::agent_fence::private_state_paths(state_dir);
    for r in &forms {
        if r.parent().is_none() || homes.iter().any(|h| h.starts_with(r)) {
            return Some("that project's folder is `/` or your home folder, which no sandboxed tab sees");
        }
        if private.iter().any(|p| r.starts_with(p)) {
            return Some(concat!("that project's folder lies inside ", crate::app_name!(), "'s own state, which no sandboxed tab sees"));
        }
    }
    None
}

/// The name a root is shown under on the chip: the project or box that owns
/// it, else the project asked for.
fn root_label(lists: &Lists, root: &Path, asked: &str) -> String {
    use super::agent_fence::{entry_directory, entry_mirror};
    let owner = lists.projects.iter().find(|p| {
        let remote = p.extra.contains_key("remote");
        (!remote && entry_directory(p).as_deref() == Some(root))
            || (remote
                && entry_mirror(p)
                    .unwrap_or_else(|| super::remote_sync::default_mirror_dir_in(lists.state_dir, &p.id))
                    == root)
    });
    if let Some(p) = owner {
        return p.name.clone();
    }
    lists
        .boxes
        .iter()
        .find(|b| b.folder.as_deref().map(Path::new) == Some(root))
        .map(|b| b.name.clone())
        .unwrap_or_else(|| asked.to_string())
}

/// Resolve one item of project `project_id` (already resolved from id or
/// name, and within the tab's grant) and read it. The own root is tried
/// first, then the project's box roots in order; only a *missing* file falls
/// through to the next root — a link, a non-file or an over-size file refuses
/// on the spot.
pub fn resolve(lists: &Lists, project_id: &str, path: &str) -> Result<Resolved, String> {
    let parts = components(path)?;
    let last = parts.last().copied().unwrap_or_default();
    if let Some(reason) = denied_name(last) {
        return Err(format!("'{last}' is not attached: {reason}"));
    }
    let asked = lists
        .projects
        .iter()
        .find(|p| p.id == project_id)
        .map(|p| p.name.clone())
        .ok_or_else(|| format!("no project named '{project_id}' (see projects_list)"))?;
    let roots = super::agent_fence::attach_roots(lists.boxes, lists.projects, project_id, lists.state_dir)
        .ok_or_else(|| format!("no project named '{project_id}' (see projects_list)"))?;
    read_from_roots(lists, &roots, &parts, &asked, path)
}

fn read_from_roots(lists: &Lists, roots: &[PathBuf], parts: &[&str], asked: &str, path: &str) -> Result<Resolved, String> {
    let private = super::agent_fence::private_state_paths(lists.state_dir);
    for (i, root) in roots.iter().enumerate() {
        if !within_grant(lists.granted, root) {
            if i == 0 {
                return Err(NOT_IN_GRANT.into());
            }
            continue;
        }
        if let Some(reason) = root_refusal(root, lists.home, lists.state_dir) {
            if i == 0 {
                return Err(format!("nothing is attached from here: {reason}"));
            }
            continue;
        }
        // Both spellings of the root, as `root_refusal` checks them: a root
        // reached through a link (or, on Windows, the `\\?\` form) to an
        // ancestor of the state must not reach it through the rest.
        let in_state = [Some(root.clone()), root.canonicalize().ok()].into_iter().flatten().any(|base| {
            let joined = parts.iter().fold(base, |p, c| p.join(c));
            private.iter().any(|p| under_any_case(&joined, p))
        });
        if in_state {
            return Err(concat!("that file lies inside ", crate::app_name!(), "'s own state, which no sandboxed tab sees").into());
        }
        match read_under(root, parts, crate::schema::mail::MAX_STAGED_BYTES) {
            Ok(bytes) => {
                let raw = parts.last().copied().unwrap_or("attachment");
                let filename = super::mail_sanitize::sanitize_attachment_name(raw).value;
                let mime = mime_guess::from_path(&filename).first_or_octet_stream().to_string();
                let source = format!("{}/{path}", root_label(lists, root, asked));
                return Ok(Resolved { filename, mime, source, bytes });
            }
            Err(Miss::NotFound) => continue,
            Err(Miss::Refused(reason)) => return Err(reason),
        }
    }
    Err(format!("no file '{path}' in that project"))
}

/// `path` at or below `prefix`, component by component, ignoring case:
/// Windows and a default (case-insensitive) macOS volume open `STATE` as
/// `state`, so an agent's spelling must not walk past the state check. On a
/// case-sensitive volume this can only refuse more.
fn under_any_case(path: &Path, prefix: &Path) -> bool {
    let fold = |p: &Path| p.components().map(|c| c.as_os_str().to_string_lossy().to_lowercase()).collect::<Vec<_>>();
    let (path, prefix) = (fold(path), fold(prefix));
    path.len() >= prefix.len() && path[..prefix.len()] == prefix[..]
}

enum Miss {
    /// Not under this root: the next root may have it.
    NotFound,
    /// Refused outright, with the reason the agent is told.
    Refused(String),
}

/// Open `root/parts…` by an `openat` walk — `O_NOFOLLOW | O_DIRECTORY` per
/// directory, `O_NOFOLLOW | O_NONBLOCK` for the file — then `fstat` the fd and
/// read at most `max + 1` bytes from it. No path string is stat'ed or
/// canonicalized, so nothing can be swapped between a check and the read.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn read_under(root: &Path, parts: &[&str], max: u64) -> Result<Vec<u8>, Miss> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;

    let cstr = |b: &[u8]| CString::new(b).map_err(|_| Miss::Refused("a NUL in the path".into()));
    let root_c = cstr(root.as_os_str().as_bytes())?;
    // The root comes from `projects.json`, the trusted list; a mirror not
    // synced yet simply is not there.
    // SAFETY: a valid C string; the fd, if any, is owned below.
    let fd = unsafe { libc::open(root_c.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) };
    if fd < 0 {
        return Err(Miss::NotFound);
    }
    // SAFETY: `fd` was just returned by `open` and is owned by nothing else.
    let mut dir = unsafe { OwnedFd::from_raw_fd(fd) };
    let Some((last, dirs)) = parts.split_last() else { return Err(Miss::NotFound) };
    for name in dirs {
        let c = cstr(name.as_bytes())?;
        // SAFETY: `dir` is an open directory fd; `c` a valid C string.
        let fd = unsafe {
            libc::openat(dir.as_raw_fd(), c.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        };
        if fd < 0 {
            return Err(open_miss(dir.as_raw_fd(), &c, name, true));
        }
        // SAFETY: as above.
        dir = unsafe { OwnedFd::from_raw_fd(fd) };
    }
    let c = cstr(last.as_bytes())?;
    // SAFETY: as above. `O_NONBLOCK`: opening a FIFO for reading must not wait
    // for a writer; the `fstat` below then refuses it.
    let fd = unsafe {
        libc::openat(dir.as_raw_fd(), c.as_ptr(), libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
    };
    if fd < 0 {
        return Err(open_miss(dir.as_raw_fd(), &c, last, false));
    }
    // SAFETY: as above.
    let file = std::fs::File::from(unsafe { OwnedFd::from_raw_fd(fd) });
    let meta = file.metadata().map_err(|e| Miss::Refused(e.to_string()))?;
    if !meta.file_type().is_file() {
        return Err(Miss::Refused(format!("'{last}' is not a regular file")));
    }
    read_capped(file, last, max)
}

/// The Windows twin of the `openat` walk, through the phone's handle-based
/// `files::ProjectDir`: the root opened by path (it comes from the trusted
/// list, and its leaf may not be a reparse point), then one `NtCreateFile`
/// per name relative to the held folder with `FILE_OPEN_REPARSE_POINT`, and
/// the handle's own metadata deciding folder, file or refusal. A junction or
/// a symbolic link at any component is refused, never followed, and the file
/// read is the handle just proven.
#[cfg(windows)]
fn read_under(root: &Path, parts: &[&str], max: u64) -> Result<Vec<u8>, Miss> {
    use super::mobile_control::files::ProjectDir;
    let link = |name: &str, what: &str| {
        Miss::Refused(format!("'{name}' is a link or {what}; links (junctions, symbolic links) are never followed, even inside the project"))
    };
    // A root that is gone (a mirror not synced yet) simply is not there.
    let Ok(mut dir) = ProjectDir::open_root(root) else { return Err(Miss::NotFound) };
    let Some((last, dirs)) = parts.split_last() else { return Err(Miss::NotFound) };
    for name in dirs {
        dir = match dir.lookup_dir(name) {
            Ok(Some(next)) => next,
            Ok(None) => return Err(Miss::NotFound),
            Err(()) => return Err(link(name, "not a folder")),
        };
    }
    match dir.lookup_file(last) {
        Ok(Some((file, _))) => read_capped(file, last, max),
        Ok(None) => Err(Miss::NotFound),
        Err(()) => Err(link(last, "not a regular file")),
    }
}

/// At most `max` bytes of a file already proven regular, read from its open
/// handle; one byte over refuses. Shared by both walks.
fn read_capped(file: std::fs::File, name: &str, max: u64) -> Result<Vec<u8>, Miss> {
    use std::io::Read;
    let mut bytes = Vec::new();
    file.take(max + 1).read_to_end(&mut bytes).map_err(|e| Miss::Refused(e.to_string()))?;
    if bytes.len() as u64 > max {
        return Err(Miss::Refused(format!("'{name}' is larger than {} MiB", max / (1024 * 1024))));
    }
    Ok(bytes)
}

/// Why an `openat` under `dir` failed. The refusal is already decided here;
/// the `fstatat` only picks the sentence (Linux answers `O_DIRECTORY |
/// O_NOFOLLOW` on a link with ENOTDIR, the same as on a plain file).
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn open_miss(dir: std::os::fd::RawFd, c: &std::ffi::CStr, name: &str, directory: bool) -> Miss {
    let link = || Miss::Refused(format!("'{name}' is a symbolic link; links are never followed, even inside the project"));
    match std::io::Error::last_os_error().raw_os_error() {
        Some(libc::ENOENT) => Miss::NotFound,
        // `O_NOFOLLOW` on a link: ELOOP (EMLINK on the BSD lineage).
        Some(libc::ELOOP) | Some(libc::EMLINK) => link(),
        Some(libc::ENOTDIR) if directory => {
            // SAFETY: `st` is written by `fstatat` before it is read; `dir` is
            // an open directory fd and `c` a valid C string.
            let mut st: libc::stat = unsafe { std::mem::zeroed() };
            let is_link = unsafe { libc::fstatat(dir, c.as_ptr(), &mut st, libc::AT_SYMLINK_NOFOLLOW) } == 0
                && (st.st_mode & libc::S_IFMT) == libc::S_IFLNK;
            if is_link { link() } else { Miss::Refused(format!("'{name}' is not a folder")) }
        }
        _ => Miss::Refused(format!("'{name}' cannot be opened")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_keeps_absent_empty_and_capped_apart() {
        assert_eq!(parse(&json!({})).unwrap(), None);
        assert_eq!(parse(&json!({ "attach": [] })).unwrap(), Some(vec![]));
        let one = parse(&json!({ "attach": [{ "project": "Alpha", "path": "out/paper.pdf" }] })).unwrap().unwrap();
        assert_eq!(one, [Request { project: "Alpha".into(), path: "out/paper.pdf".into() }]);
        let six: Vec<Value> = (0..6).map(|i| json!({ "project": "a", "path": format!("f{i}") })).collect();
        assert!(parse(&json!({ "attach": six })).is_err());
        assert!(parse(&json!({ "attach": [{ "project": "a" }] })).is_err());
        assert!(parse(&json!({ "attach": "a/b" })).is_err());
    }

    #[test]
    fn components_refuse_every_escape_before_io() {
        assert_eq!(components("out/paper.pdf").unwrap(), ["out", "paper.pdf"]);
        for bad in ["../x", "a/../b", "/etc/passwd", "a\\b", "a\0b", "a//b", "./a", "a/", ".git/config", "sub/.GIT/HEAD"] {
            assert!(components(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn secret_shaped_names_are_named() {
        for name in [".env", ".env.local", "id_ed25519", "id_rsa.pub", "foo.pem", "server.KEY", ".netrc", "credentials.json", "api_token.txt", "client_secret.json", "vault.kdbx"] {
            assert!(denied_name(name).is_some(), "{name}");
        }
        for name in ["paper.pdf", "notes.txt", "keynote.pdf", "environment.yml"] {
            assert!(denied_name(name).is_none(), "{name}");
        }
    }

    /// The Windows arm's checks before any I/O, run on every platform: what
    /// Windows would open as a drive, a stream or another (long) name.
    #[test]
    fn windows_aliases_are_refused_before_io() {
        for bad in ["notes.txt:hidden", ".git::$INDEX_ALLOCATION", "C:", "GIT~1", "ENV~1.LOC", "paper.pdf.", "paper.pdf ", ".git."] {
            assert!(windows_part_refusal(bad).is_some(), "{bad:?}");
        }
        for ok in ["paper.pdf", "~notes.txt", "draft~final.md", "v1.2", ".hidden"] {
            assert!(windows_part_refusal(ok).is_none(), "{ok:?}");
        }
        // Only Windows applies them: a `:` is an ordinary name on Unix.
        assert_eq!(components("out/a:b.txt").is_err(), cfg!(windows));
    }

    #[test]
    fn the_state_check_ignores_case() {
        let state = Path::new("/w/state");
        assert!(under_any_case(Path::new("/w/STATE/mail/x"), state));
        assert!(under_any_case(Path::new("/w/state"), state));
        assert!(!under_any_case(Path::new("/w/states/x"), state), "component-wise");
        assert!(!under_any_case(Path::new("/w"), state));
    }

    #[test]
    fn a_project_outside_the_spawn_grant_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let (alpha, beta) = (dir.path().join("w/alpha"), dir.path().join("w/alpha2"));
        for d in [&alpha, &beta] {
            std::fs::create_dir_all(d).unwrap();
            std::fs::write(d.join("notes.txt"), b"hi").unwrap();
        }
        let projects: ProjectsList = serde_json::from_value(serde_json::json!([
            {"id":"a","name":"Alpha","status":"active","position":0,"local_file":"","directory": alpha},
            {"id":"b","name":"Later","status":"active","position":1,"local_file":"","directory": beta}
        ])).unwrap();
        let (state, home) = (dir.path().join("state"), dir.path().join("home"));
        // The tab was spawned while only Alpha existed.
        let granted = vec![alpha.clone()];
        let lists = Lists { projects: &projects, boxes: &Vec::new(), state_dir: &state, home: &home, granted: Some(&granted) };
        assert!(resolve(&lists, "a", "notes.txt").is_ok());
        assert_eq!(resolve(&lists, "b", "notes.txt").unwrap_err(), NOT_IN_GRANT, "a sibling sharing a name prefix is not inside");
        let unfenced = Lists { granted: None, ..lists };
        assert!(resolve(&unfenced, "b", "notes.txt").is_ok());
    }

    #[test]
    fn roots_at_slash_home_or_state_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let state = home.join(concat!(".local/share/", crate::app_slug!()));
        std::fs::create_dir_all(&state).unwrap();
        assert!(root_refusal(Path::new("/"), &home, &state).is_some());
        assert!(root_refusal(&home, &home, &state).is_some());
        assert!(root_refusal(dir.path(), &home, &state).is_some(), "an ancestor of home");
        assert!(root_refusal(&state.join("remote-projects/p/mirror"), &home, &state).is_some());
        assert!(root_refusal(&home.join("work/alpha"), &home, &state).is_none());
    }

    /// A root reached through a link to an ancestor of the state folder
    /// (passes `root_refusal`, which sees neither home nor state in it) must
    /// not read the state through the agent-spelled rest of the path.
    #[cfg(unix)]
    #[test]
    fn a_linked_root_above_the_state_does_not_reach_it() {
        let dir = tempfile::tempdir().unwrap();
        let (share, link) = (dir.path().join("share"), dir.path().join("link"));
        let state = share.join("state");
        std::fs::create_dir_all(state.join("mail")).unwrap();
        std::fs::write(state.join("mail/store.json"), b"private").unwrap();
        std::os::unix::fs::symlink(&share, &link).unwrap();
        let projects: ProjectsList = serde_json::from_value(serde_json::json!([
            {"id":"a","name":"Alpha","status":"active","position":0,"local_file":"","directory": link}
        ])).unwrap();
        let home = dir.path().join("home");
        let lists = Lists { projects: &projects, boxes: &Vec::new(), state_dir: &state, home: &home, granted: None };
        let err = resolve(&lists, "a", "state/mail/store.json").unwrap_err();
        assert!(err.contains("own state"), "{err}");
    }

    // Junctions need neither Administrator rights nor Developer Mode, so
    // Windows CI builds the fixture; a failed `mklink` fails the test.
    #[cfg(windows)]
    fn junction(target: &Path, link: &Path) {
        use std::os::windows::process::CommandExt;
        let output = std::process::Command::new("cmd")
            .raw_arg(format!("/D /C mklink /J \"{}\" \"{}\"", link.display(), target.display()))
            .output()
            .unwrap();
        assert!(output.status.success(), "mklink: {}", String::from_utf8_lossy(&output.stderr));
    }

    /// The handle walk: a plain file attaches; a junction anywhere on the
    /// way refuses on the spot (inside the project or out of it), and a
    /// folder named as the file refuses too.
    #[cfg(windows)]
    #[test]
    fn junctions_are_refused_never_followed() {
        let dir = tempfile::tempdir().unwrap();
        let (alpha, outside) = (dir.path().join("w/alpha"), dir.path().join("outside"));
        for d in [alpha.join("out"), outside.clone()] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(alpha.join("out/paper.pdf"), b"%PDF").unwrap();
        // Not a credential-looking name: that check would refuse it before the walk.
        std::fs::write(outside.join("notes.txt"), b"private").unwrap();
        junction(&outside, &alpha.join("away"));
        junction(&alpha.join("out"), &alpha.join("alias"));
        let projects: ProjectsList = serde_json::from_value(serde_json::json!([
            {"id":"a","name":"Alpha","status":"active","position":0,"local_file":"","directory": alpha}
        ])).unwrap();
        let (state, home) = (dir.path().join("state"), dir.path().join("home"));
        let lists = Lists { projects: &projects, boxes: &Vec::new(), state_dir: &state, home: &home, granted: None };
        assert_eq!(resolve(&lists, "a", "out/paper.pdf").unwrap().bytes, b"%PDF");
        for path in ["away/notes.txt", "alias/paper.pdf", "away", "out"] {
            let err = resolve(&lists, "a", path).unwrap_err();
            assert!(err.contains("never followed"), "{path}: {err}");
        }
        assert!(resolve(&lists, "a", "out/missing.pdf").unwrap_err().contains("no file"));
    }
}

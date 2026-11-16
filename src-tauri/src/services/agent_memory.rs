//! The agent CLIs' own memories for a project, listed and read, read-only.
//!
//! Claude Code keeps an auto memory per project at
//! `<home>/.claude/projects/<encoded cwd>/memory/*.md` (`MEMORY.md` is its
//! index), Codex keeps its memories at `<home>/.codex/memories/`. In
//! Tabtivity both live in the *project scope's agent home* (and in the
//! scope's local-model home, a second home of its own). Tabtivity writes none
//! of it and has no memory of its own: the files are the CLIs'.
//!
//! The agent home is **agent-writable**, so nothing here goes by a joined
//! path: every directory is opened through `home_io` handles (a link at any
//! component is refused), every name is checked against the directory listing
//! before it is opened, files are regular only (never through a link, never
//! waited on if a FIFO), and entry counts and bytes are capped. The renderer
//! sends only `(cli, home, name)`, never a path. A folder that is not there —
//! a CLI version that keeps its memory elsewhere, a project that never
//! produced one — is simply an empty list, not an error.
//!
//! `AppHandle`-free and unit-testable: the homes and project folders are
//! arguments ([`Source`]), the commands (`commands::project_docs`) resolve
//! them.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::services::home_io::{HomeDir, HomeFile};

/// Entries read from one memory folder, and listed in all.
const MAX_ENTRIES_PER_DIR: usize = 256;
const MAX_ENTRIES: usize = 200;
/// The largest memory file listed or read; a bigger one is not offered (it
/// would be a dead row).
pub const MAX_MEMORY_BYTES: u64 = 1 << 20;
/// Claude Code shortens an encoded folder name past this (adding a hash we do
/// not reproduce): such a project simply lists nothing.
const CLAUDE_NAME_LIMIT: usize = 200;

/// The CLI a memory belongs to.
pub const CLAUDE: &str = "claude";
pub const CODEX: &str = "codex";

/// Which of a scope's two homes an entry is in.
pub const HOME_SCOPE: &str = "scope";
pub const HOME_LOCAL: &str = "local";

/// One agent home to look in: its kind ([`HOME_SCOPE`] / [`HOME_LOCAL`]) and
/// path.
#[derive(Debug, Clone)]
pub struct Source {
    pub kind: &'static str,
    pub home: PathBuf,
}

/// One memory file, as the listing shows it. Serialised camelCase.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    /// `"claude"` or `"codex"`.
    pub cli: &'static str,
    /// `"scope"` or `"local"`: which home of the project's scope.
    pub home: &'static str,
    /// The file's leaf name, `MEMORY.md`.
    pub name: String,
    pub bytes: u64,
    pub modified_secs: Option<u64>,
}

/// Claude Code's folder name for a working directory: every UTF-16 unit that
/// is not an ASCII letter or digit becomes `-` (`/home/u/my.proj` ->
/// `-home-u-my-proj`). `None` past the length it stops encoding plainly at.
pub fn claude_project_dir_name(root: &Path) -> Option<String> {
    let text = root.to_str()?;
    let name: String = text
        .encode_utf16()
        .map(|u| match u8::try_from(u) {
            Ok(b) if b.is_ascii_alphanumeric() => b as char,
            _ => '-',
        })
        .collect();
    (name.len() <= CLAUDE_NAME_LIMIT).then_some(name)
}

/// The project folders to look under: the path as the project holds it, and
/// where it resolves to, since a CLI may record either — and the canonical git
/// root of each, because Claude Code keys a project's auto memory by that root
/// (the installed 2.1.321: the working-copy root, else `findCanonicalGitRoot`,
/// else the folder itself), so a project that is a subfolder of a repository
/// shares the repository's memory, and a linked worktree its main working
/// copy's.
fn roots_of(project_dirs: &[PathBuf]) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    for dir in project_dirs {
        let resolved = std::fs::canonicalize(dir).ok();
        for candidate in [Some(dir.clone()), resolved.clone()].into_iter().flatten() {
            if !roots.contains(&candidate) {
                roots.push(candidate);
            }
        }
        for base in [Some(dir.as_path()), resolved.as_deref()].into_iter().flatten() {
            if let Some(root) = canonical_git_root(base) {
                if !roots.contains(&root) {
                    roots.push(root);
                }
            }
        }
    }
    roots
}

/// The longest a `.git` file (a worktree's pointer) or `commondir` is read.
const GIT_POINTER_CAP: u64 = 4096;

/// The repository root `dir` lives in, the way Claude Code names it: the
/// nearest ancestor holding a `.git` directory; for a `.git` *file* (a linked
/// worktree) the main working copy that its `commondir` names; a `.git` file
/// without one (a submodule) is its own root. `None` outside any repository.
///
/// The project folder is attacker-controlled, so this only reads small plain
/// files through `home_io` (never through a link, never waiting on a FIFO) and
/// only ever yields a *name* to look up under the agent home.
fn canonical_git_root(dir: &Path) -> Option<PathBuf> {
    use crate::services::home_io::read_record_capped;
    for ancestor in dir.ancestors() {
        let dot_git = ancestor.join(".git");
        let Ok(meta) = std::fs::symlink_metadata(&dot_git) else { continue };
        if meta.is_dir() {
            return Some(ancestor.to_path_buf());
        }
        if !meta.is_file() {
            continue;
        }
        let pointer = read_record_capped(&dot_git, GIT_POINTER_CAP)?;
        let gitdir = Path::new(pointer.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim());
        let gitdir = if gitdir.is_absolute() { gitdir.to_path_buf() } else { ancestor.join(gitdir) };
        let Some(common) = read_record_capped(&gitdir.join("commondir"), GIT_POINTER_CAP) else {
            return Some(ancestor.to_path_buf());
        };
        let common = std::fs::canonicalize(gitdir.join(common.trim())).ok()?;
        return match common.file_name() {
            Some(n) if n == ".git" => common.parent().map(Path::to_path_buf),
            _ => Some(ancestor.to_path_buf()),
        };
    }
    None
}

/// A memory file found: the entry and the handle to read it through.
struct Found {
    entry: MemoryEntry,
    file: HomeFile,
}

/// Every memory file of `sources` for a project living in `project_dirs`:
/// Claude's before Codex's within a home, the scope's home before the
/// local-model home, `MEMORY.md` first in each folder.
fn scan(sources: &[Source], project_dirs: &[PathBuf]) -> Vec<Found> {
    let roots = roots_of(project_dirs);
    let mut found = Vec::new();
    for source in sources {
        let mut folders: Vec<(&'static str, HomeDir)> = Vec::new();
        for root in &roots {
            let Some(name) = claude_project_dir_name(root) else { continue };
            if let Some(dir) = HomeDir::open_existing(&source.home, &format!(".claude/projects/{name}/memory")) {
                folders.push((CLAUDE, dir));
            }
        }
        if let Some(dir) = HomeDir::open_existing(&source.home, ".codex/memories") {
            folders.push((CODEX, dir));
        }
        for (cli, dir) in folders {
            for name in ordered_names(&dir) {
                if found.len() >= MAX_ENTRIES {
                    return found;
                }
                let Some(file) = dir.file(&name) else { continue };
                let Some(handle) = file.open_read() else { continue };
                let Ok(meta) = handle.metadata() else { continue };
                if meta.len() > MAX_MEMORY_BYTES {
                    continue;
                }
                // One folder per (cli, name): a second root that encodes to
                // another folder never shadows or doubles the first.
                if found.iter().any(|f: &Found| f.entry.cli == cli && f.entry.home == source.kind && f.entry.name == name) {
                    continue;
                }
                let modified_secs = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs());
                found.push(Found {
                    entry: MemoryEntry { cli, home: source.kind, name, bytes: meta.len(), modified_secs },
                    file,
                });
            }
        }
    }
    found
}

/// The `.md` names of a memory folder, `MEMORY.md` first, the rest sorted.
fn ordered_names(dir: &HomeDir) -> Vec<String> {
    let mut names: Vec<String> = dir
        .names_capped(MAX_ENTRIES_PER_DIR)
        .into_iter()
        .filter(|n| n.len() > ".md".len() && n.to_ascii_lowercase().ends_with(".md"))
        .collect();
    // The listing is cut at the cap in directory order, which says nothing about
    // where the index falls: ask for it by name too. `scan` skips it when it is
    // not there (or not a plain file), and a name already listed is not doubled.
    if !names.iter().any(|n| n == "MEMORY.md") {
        names.push("MEMORY.md".to_string());
    }
    names.sort_by(|a, b| (a != "MEMORY.md").cmp(&(b != "MEMORY.md")).then_with(|| a.cmp(b)));
    names
}

/// The memory files the CLIs hold for the project.
pub fn list(sources: &[Source], project_dirs: &[PathBuf]) -> Vec<MemoryEntry> {
    scan(sources, project_dirs).into_iter().map(|f| f.entry).collect()
}

/// One memory file as text. `(cli, home, name)` must be in the listing —
/// anything else (a path, a link, a file that is not there) is `None`.
pub fn read(sources: &[Source], project_dirs: &[PathBuf], cli: &str, home: &str, name: &str) -> Option<String> {
    let found = scan(sources, project_dirs)
        .into_iter()
        .find(|f| f.entry.cli == cli && f.entry.home == home && f.entry.name == name)?;
    String::from_utf8(found.file.read_capped(MAX_MEMORY_BYTES)?).ok()
}

#[cfg(test)]
mod tests;

//! Filesystem command handlers: the file-tree browser, gitignore editing, MIME
//! detection, and the absolute-path file readers/writers backing the in-app
//! viewers. Extracted from `commands::projects` (Structure #1) so the
//! path-confinement security work (Security #1/#3) and MIME-laziness work
//! (Efficiency #15) have a dedicated, testable home alongside `fs_watch`.

use std::collections::{BTreeSet, HashSet};
use app_core::sync::LockExt;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::schema::boxes::BoxesList;
use crate::schema::projects::{ProjectEntry, ProjectsList};
use crate::services::tree_copy::{copy_tree, CopyReport};
use crate::storage;
use crate::tauri_host::Ctx;
use app_core::CoreCtx;
pub(crate) use crate::paths::{canonical_or_new, display_path, enforce_confinement};

// ── File tree ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified_secs: Option<u64>,
    pub created_secs: Option<u64>,
    pub extension: Option<String>,
    pub mime: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProjectPathEntry {
    pub path: String,
    pub is_dir: bool,
}

/// Resolve the extension's MIME type lazily. Efficiency #15: only call this when
/// a MIME is actually needed rather than eagerly for every listed file.
fn mime_for_ext(ext: &str) -> String {
    mime_guess::from_ext(ext.trim_start_matches('.'))
        .first_or_octet_stream()
        .to_string()
}

/// Build a [`FileEntry`] from a directory entry's path + metadata. Shared by the
/// project-confined lister ([`list_dir_local`]) and the unconfined downloads
/// scanner ([`list_recent_downloads`]) so both produce byte-identical shapes.
fn file_entry_from(path: &Path, meta: &fs::Metadata, name: String) -> FileEntry {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| format!(".{s}"));
    // Efficiency #15: compute the MIME lazily from the extension only when there
    // is one, instead of always producing octet-stream fallbacks.
    let mime = ext.as_deref().map(mime_for_ext);
    FileEntry {
        name,
        path: display_path(path),
        is_dir: meta.is_dir(),
        size: if meta.is_file() { meta.len() } else { 0 },
        modified_secs: meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs()),
        created_secs: meta
            .created()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs()),
        extension: ext,
        mime,
    }
}

/// List directory contents — project-aware (mount-free remote, Phase 2):
///
/// - **Remote project** → list the directory over SFTP, riding the pooled
///   session opened on activation (`services::remote`), or a one-shot session if
///   the pool is cold. Detected FIRST, before any local-fs touch, via
///   [`remote_target_for_dir`] (the `project_dir` the frontend passes is the
///   project's stored `directory`).
/// - **Local project** → `fs::read_dir`, validating the path stays inside the
///   project root. Byte-identical to the pre-Phase-2 behavior.
///
/// The SFTP pool comes from the host context; the frontend does not pass it.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn list_dir(
    project_dir: String,
    rel_path: String,
    ctx: Ctx,
) -> Result<Vec<FileEntry>, String> {
    let pool = ctx.get::<RemotePoolState>();
    // Detect remote BEFORE any local-fs access (`canonical` would touch the fs).
    if let Some(target) = crate::services::remote::remote_target_for_dir(&project_dir) {
        return list_dir_remote(&target, &rel_path, pool).await;
    }
    app_core::rt::try_blocking("fs", move || list_dir_local(&project_dir, &rel_path)).await
}

/// Local-fs directory listing — the pre-Phase-2 behavior, byte-identical.
/// Split out of the `list_dir` command so it stays sync (no Tauri `State`) and
/// is directly unit/integration-testable.
pub fn list_dir_local(project_dir: &str, rel_path: &str) -> Result<Vec<FileEntry>, String> {
    let root = canonical(project_dir)?;
    let target = if rel_path.is_empty() {
        root.clone()
    } else {
        canonical(root.join(rel_path).to_string_lossy().as_ref())?
    };

    enforce_confinement(&root, &target)?;

    let entries = fs::read_dir(&target).map_err(|e| e.to_string())?;

    let mut result: Vec<FileEntry> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        // Always hide .tabtivity/ — it is internal runtime storage, not user content.
        if crate::brand::is_project_dir(&name) {
            continue;
        }
        result.push(file_entry_from(&path, &meta, name));
    }
    result.sort_by_cached_key(|entry| (!entry.is_dir, entry.name.to_lowercase()));
    Ok(result)
}

/// The most path-shaped words one `resolve_text_paths` call looks up.
const TEXT_PATHS_MAX: usize = 256;
/// The most folders they are looked up under (the tab's folder, its project's).
const TEXT_PATH_BASES_MAX: usize = 4;

/// Which of `candidates` — path-shaped words an agent wrote in a terminal or
/// its chat (`src/lib/terminal/pathLinks.ts`) — name an existing file or folder
/// inside one of `bases`, for the frontend to make them links that open the
/// file's tab. Local only: the frontend never asks for a remote-run tab.
///
/// A relative candidate is tried under each base in order, an absolute one
/// against all of them; either must still lie inside that base once links are
/// resolved, so `../` or a symlink can't reach out of it. The text is the
/// agent's (and so whatever the project fed it), which is why nothing outside
/// the bases is ever answered. The project's own `.tabtivity` folder is never
/// answered either. The returned path is the lexical one (the base as given,
/// joined), not the canonical one, so it prefix-matches the project directory
/// the frontend holds. One answer per candidate, in order; `None` = no link.
///
/// Every candidate is a canonicalize and a stat, so the lookup runs on a
/// worker. A worker that fails is an error, not "no links": the frontend
/// would remember those.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn resolve_text_paths(
    bases: Vec<String>,
    candidates: Vec<String>,
) -> Result<Vec<Option<FileEntry>>, String> {
    app_core::rt::blocking("fs", move || resolve_text_paths_blocking(bases, candidates)).await
}

/// The body of [`resolve_text_paths`], on the calling thread.
pub fn resolve_text_paths_blocking(bases: Vec<String>, candidates: Vec<String>) -> Vec<Option<FileEntry>> {
    let bases: Vec<(PathBuf, PathBuf)> = bases
        .iter()
        .filter(|b| !b.is_empty())
        .take(TEXT_PATH_BASES_MAX)
        .filter_map(|b| {
            let lexical = normalize_lexical(Path::new(b));
            fs::canonicalize(&lexical).ok().map(|c| (lexical, c))
        })
        .collect();
    candidates
        .iter()
        .enumerate()
        .map(|(i, c)| if i < TEXT_PATHS_MAX { resolve_text_path(&bases, c) } else { None })
        .collect()
}

fn resolve_text_path(bases: &[(PathBuf, PathBuf)], candidate: &str) -> Option<FileEntry> {
    if candidate.is_empty() || candidate.len() > 4096 || candidate.contains('\0') {
        return None;
    }
    let cand = Path::new(candidate);
    for (lexical, canon) in bases {
        let joined = normalize_lexical(&lexical.join(cand));
        // A `..` that climbs above the base is refused before the fs is touched.
        let Ok(rel) = joined.strip_prefix(lexical) else { continue };
        if rel.components().any(|c| crate::brand::is_project_dir(&c.as_os_str().to_string_lossy())) {
            continue;
        }
        let Ok(real) = fs::canonicalize(&joined) else { continue };
        if !real.starts_with(canon) {
            continue;
        }
        let Ok(meta) = fs::metadata(&real) else { continue };
        let name = joined
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let mut entry = file_entry_from(&joined, &meta, name);
        entry.path = display_path(&joined);
        return Some(entry);
    }
    None
}

/// `path` with its `.` and `..` segments folded away without touching the fs
/// (a `..` at the root stays at the root).
fn normalize_lexical(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => match out.components().next_back() {
                Some(Component::RootDir | Component::Prefix(_)) => {}
                None | Some(Component::ParentDir) => out.push(comp),
                Some(_) => {
                    out.pop();
                }
            },
            other => out.push(other),
        }
    }
    out
}

/// Scan one or more download *source* folders and return their recently-modified
/// entries, merged and sorted newest-first. Backs the side-panel Downloads
/// section (fast-copy of freshly downloaded files into a project).
///
/// Unlike [`list_dir`], the `paths` are user-chosen source folders that live
/// OUTSIDE any project root, so path-confinement deliberately does not apply here
/// — this is a read-only scan the user explicitly configured. Missing/unreadable
/// folders are skipped rather than failing the whole call (a stale configured
/// path must not break the section). Dot-hidden entries are skipped; top-level
/// files and folders are included (a browser can drop a folder), no recursion.
///
/// `since_secs` (Unix seconds) keeps only entries modified at or after it; `None`
/// returns everything. Results are sorted by `modified_secs` descending, then by
/// name, so the most recent download is first. A listing and a stat per
/// entry, so on a worker.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn list_recent_downloads(
    paths: Vec<String>,
    since_secs: Option<u64>,
) -> Result<Vec<FileEntry>, String> {
    app_core::rt::try_blocking("fs", move || list_recent_downloads_blocking(paths, since_secs)).await
}

fn list_recent_downloads_blocking(
    paths: Vec<String>,
    since_secs: Option<u64>,
) -> Result<Vec<FileEntry>, String> {
    let mut result: Vec<FileEntry> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for dir in &paths {
        let entries = match fs::read_dir(dir) {
            Ok(e) => e,
            // Missing/unreadable source dir — skip it, don't fail the whole scan.
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let name = entry.file_name().to_string_lossy().to_string();
            // Skip dot-hidden entries (partial-download temp files, etc.).
            if name.starts_with('.') {
                continue;
            }
            let fe = file_entry_from(&path, &meta, name);
            if let Some(since) = since_secs {
                if !matches!(fe.modified_secs, Some(m) if m >= since) {
                    continue;
                }
            }
            // De-dupe when the same absolute path is reachable via two configured
            // source folders (e.g. a folder plus a symlink pointing into it).
            if seen.insert(fe.path.clone()) {
                result.push(fe);
            }
        }
    }
    result.sort_by(|a, b| {
        b.modified_secs
            .cmp(&a.modified_secs)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(result)
}

// ── Remote (SFTP) directory listing (mount-free remote, Phase 2) ────────────

/// List a remote project's directory over SFTP and map the entries into the same
/// `FileEntry` shape the local lister returns. Prefers the pooled session opened
/// on activation; if the project is not connected (cold pool / dropped link) it
/// falls back to a one-shot session so browsing still works. An unreachable host
/// surfaces as the `Err` from the SFTP layer (ConnectTimeout) rather than hanging.
async fn list_dir_remote(
    target: &crate::services::remote::RemoteTarget,
    rel_path: &str,
    pool: &crate::services::remote::RemotePoolState,
) -> Result<Vec<FileEntry>, String> {
    let spec = &target.spec;
    let remote_dir = join_remote_dir(&spec.remote_path, rel_path);

    let entries = match crate::services::remote::pooled_sftp(pool, &target.project_id).await {
        Some(sftp) => crate::services::sftp::list_dir_on(&sftp, &remote_dir).await?,
        // Cold pool: one-shot session (key/agent auth — no stored password). The
        // one-shot path uses ConnectTimeout so an unreachable host fails fast.
        None => {
            crate::services::sftp::list_dir(&spec.user, &spec.host, spec.port, None, &remote_dir)
                .await?
        }
    };

    Ok(entries
        .into_iter()
        // Always hide .tabtivity/ — mirrors the local lister (internal runtime dir).
        .filter(|e| !crate::brand::is_project_dir(&e.name))
        .map(|e| remote_file_entry(&remote_dir, e))
        .collect())
}

/// Recursive byte size of a single directory — project-aware, mirroring
/// [`list_dir`]. Computed lazily by the file tree (one call per folder shown), so
/// it is kept off the listing hot path: the tree renders immediately and folder
/// sizes fill in as they resolve.
///
/// - **Remote project** → `du` on the host over SSH (`remote_dir_size`).
/// - **Local project** → walk the subtree on a blocking thread so a large folder
///   (e.g. `node_modules`) never stalls the async runtime.
///
/// A folder that can't be fully read yields the partial total rather than an
/// error, since this is a best-effort display aid.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn dir_size(
    project_dir: String,
    rel_path: String,
    excluded: Option<Vec<String>>,
    ctx: Ctx,
) -> Result<u64, String> {
    let pool = ctx.get::<RemotePoolState>();
    let _ = &pool; // remote path uses SSH exec, not the SFTP pool; keep the arg for symmetry
    if let Some(target) = crate::services::remote::remote_target_for_dir(&project_dir) {
        let remote_dir = join_remote_dir(&target.spec.remote_path, &rel_path);
        let spec = target.spec.clone();
        return app_core::rt::blocking("fs", move || {
            crate::services::ssh_exec::remote_dir_size(&spec, &remote_dir)
        })
        .await?;
    }
    let excluded = excluded.unwrap_or_default();
    app_core::rt::try_blocking("fs", move || dir_size_local(&project_dir, &rel_path, &excluded))
        .await
}

/// Local-fs recursive directory size (bytes). Confinement-checked like the local
/// lister, then a symlink-skipping walk (so a symlink cycle can't loop forever).
pub fn dir_size_local(
    project_dir: &str,
    rel_path: &str,
    excluded: &[String],
) -> Result<u64, String> {
    let root = canonical(project_dir)?;
    let target = if rel_path.is_empty() {
        root.clone()
    } else {
        canonical(root.join(rel_path).to_string_lossy().as_ref())?
    };
    enforce_confinement(&root, &target)?;
    // The walk builds rel paths from `rel_path` down, so the exclusion list —
    // which is project-root-relative — matches at any depth under the folder.
    Ok(walk_dir_size(
        &target,
        rel_path.trim_matches('/'),
        &excluded_rel_set(excluded),
    ))
}

/// Normalise the caller's scan-exclusion list into the same project-relative,
/// forward-slash spelling the walks build as they descend.
///
/// The list is the user's own (`scan_excluded_paths` in `project.json`, set from
/// the file tree's "Exclude from scans"), so it is whatever they clicked plus
/// whatever survived a hand edit: tolerate `./x`, `/x`, `x/`, and Windows
/// separators rather than silently failing to match one of them.
pub fn excluded_rel_set(excluded: &[String]) -> HashSet<String> {
    excluded
        .iter()
        .map(|raw| raw.replace('\\', "/"))
        .map(|rel| {
            rel.trim()
                .trim_matches('/')
                .trim_start_matches("./")
                .to_string()
        })
        .filter(|rel| !rel.is_empty())
        .collect()
}

/// Sum file sizes under `dir`, recursing into subdirectories. Symlinks are never
/// followed (avoids cycles and double-counting); unreadable dirs/entries are
/// skipped, so the result is a best-effort total.
///
/// `excluded` prunes whole subtrees the user has excluded from scans. It is a
/// *prune*, not a filter: the point is not to leave those bytes out of the total
/// but to never descend into them at all — this walk is what made opening a
/// project with a 50 GB virtualenv peg a core for minutes.
fn walk_dir_size(dir: &Path, rel_prefix: &str, excluded: &HashSet<String>) -> u64 {
    let mut total = 0u64;
    let Ok(rd) = fs::read_dir(dir) else {
        return 0;
    };
    for entry in rd.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let child_rel = if rel_prefix.is_empty() {
            name
        } else {
            format!("{rel_prefix}/{name}")
        };
        if excluded.contains(&child_rel) {
            continue;
        }
        if ft.is_dir() {
            total = total.saturating_add(walk_dir_size(&entry.path(), &child_rel, excluded));
        } else if ft.is_file() {
            if let Ok(m) = entry.metadata() {
                total = total.saturating_add(m.len());
            }
        }
    }
    total
}

#[derive(Debug, Serialize)]
pub struct DirSizeBreakdown {
    pub total: u64,
    pub ignored: u64,
}

/// Recursive byte size of a folder split into git-ignored vs
/// tracked/untracked content, so a mixed folder (e.g. source alongside a
/// build output dir) can show how much of its weight is ignored content.
/// Local projects only: splitting by ignore status needs a `git status`
/// process, and there is no cheap way to run one against a remote host's
/// index without a dedicated round trip per lazily-shown folder — a remote
/// folder (or one with no `.git`) just gets `ignored: 0`, same best-effort
/// fallback as [`dir_size`] on failure.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn dir_size_breakdown(
    project_dir: String,
    rel_path: String,
    excluded: Option<Vec<String>>,
) -> Result<DirSizeBreakdown, String> {
    let excluded = excluded.unwrap_or_default();
    app_core::rt::try_blocking("fs", move || {
        dir_size_breakdown_local(&project_dir, &rel_path, &excluded)
    })
    .await
}

fn dir_size_breakdown_local(
    project_dir: &str,
    rel_path: &str,
    excluded: &[String],
) -> Result<DirSizeBreakdown, String> {
    // A remote project's `project_dir` is a local per-project STATE dir (holds
    // project.json/sync.json/git_peer.json, never the tree itself) — canonicalizing
    // it and walking `<state_dir>/<rel_path>` as done below always found nothing and
    // silently reported 0 bytes for every folder, the "shows 0B" bug. Fixed the same
    // way `dir_size` already handles it: `du` the real path on the host over SSH.
    // Deliberately does NOT fall back to a local mirror even when one exists — a
    // "Remote" view must reflect the host's actual tree (e.g. a folder covered
    // entirely by `.gitignore`, which lockstep never pushes, must show as absent
    // there, not silently stand in with the mirror's copy). That substitution
    // already belongs to the frontend's own Local/Remote toggle: selecting "Local"
    // routes `list_dir`/`dir_size`/`dir_size_breakdown` straight at the mirror path
    // before this command is ever called with a remote `project_dir`.
    if let Some(target) = crate::services::remote::remote_target_for_dir(project_dir) {
        let remote_dir = join_remote_dir(&target.spec.remote_path, rel_path);
        let total = crate::services::ssh_exec::remote_dir_size(&target.spec, &remote_dir)?;
        return Ok(DirSizeBreakdown { total, ignored: 0 });
    }

    let root = canonical(project_dir)?;
    let target = if rel_path.is_empty() {
        root.clone()
    } else {
        canonical(root.join(rel_path).to_string_lossy().as_ref())?
    };
    enforce_confinement(&root, &target)?;

    let prefix = rel_path.trim_matches('/');
    let excluded = excluded_rel_set(excluded);
    if !root.join(".git").exists() {
        return Ok(DirSizeBreakdown {
            total: walk_dir_size(&target, prefix, &excluded),
            ignored: 0,
        });
    }

    let ignored = ignored_paths_under(&root, rel_path);
    let (total, ignored_bytes) = walk_dir_size_breakdown(&target, prefix, &ignored, &excluded);
    Ok(DirSizeBreakdown {
        total,
        ignored: ignored_bytes,
    })
}

/// The set of repo-root-relative paths (matching git's own porcelain output)
/// that `git status` reports as ignored (`!!`) anywhere under `rel_path`.
/// `--untracked-files=all` is what makes this useful: without it, git
/// collapses a wholly-ignored directory to one line for the directory itself
/// rather than recursing into it (see `commands::git::git_file_statuses`'s
/// `wholly_ignored` handling for the same quirk) — here we want every
/// individual ignored file, at any depth, so [`walk_dir_size_breakdown`] can
/// classify each file it visits by simple set membership. A failed/absent
/// `git` yields an empty set, so the breakdown degrades to "0 ignored"
/// rather than erroring.
fn ignored_paths_under(root: &Path, rel_path: &str) -> HashSet<String> {
    let mut args = vec![
        "status",
        "--porcelain",
        "--ignored",
        "--untracked-files=all",
    ];
    if !rel_path.is_empty() {
        args.push("--");
        args.push(rel_path);
    }
    // Hardened: `status` in a project directory a container mounts writable, so
    // the repo's config is untrusted (`commands::git`, Group O #151);
    // `hardened_git_command_in` sanitizes it first.
    let Ok(out) = crate::services::git_bounded::output(crate::commands::git::hardened_git_command_in(root, &args)) else {
        return HashSet::new();
    };
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines()
        .filter_map(|line| {
            if line.len() < 4 || &line[..2] != "!!" {
                return None;
            }
            Some(line[3..].trim_matches('"').to_string())
        })
        .collect()
}

/// Like [`walk_dir_size`], but also sums the subset of bytes whose
/// repo-root-relative path (`rel_prefix` + entry name, built up as recursion
/// descends) is in `ignored`. Directories themselves never appear in
/// `ignored` (git only reports leaf files under `--untracked-files=all`), so
/// this always recurses rather than short-circuiting on a directory match —
/// the leaf files inside eventually match individually regardless of depth.
fn walk_dir_size_breakdown(
    dir: &Path,
    rel_prefix: &str,
    ignored: &HashSet<String>,
    excluded: &HashSet<String>,
) -> (u64, u64) {
    let mut total = 0u64;
    let mut ignored_total = 0u64;
    let Ok(rd) = fs::read_dir(dir) else {
        return (0, 0);
    };
    for entry in rd.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let child_rel = if rel_prefix.is_empty() {
            name
        } else {
            format!("{rel_prefix}/{name}")
        };
        if excluded.contains(&child_rel) {
            continue;
        }
        if ft.is_dir() {
            let (t, i) = walk_dir_size_breakdown(&entry.path(), &child_rel, ignored, excluded);
            total = total.saturating_add(t);
            ignored_total = ignored_total.saturating_add(i);
        } else if ft.is_file() {
            if let Ok(m) = entry.metadata() {
                let bytes = m.len();
                total = total.saturating_add(bytes);
                if ignored.contains(&child_rel) {
                    ignored_total = ignored_total.saturating_add(bytes);
                }
            }
        }
    }
    (total, ignored_total)
}

/// Join a remote project root (`remote_path`) with a project-relative path,
/// mirroring `ssh_exec::remote_subdir`-style joining: trim a trailing '/', then
/// append the non-empty rel. Pure, so it is unit-tested without a live host.
fn join_remote_dir(remote_path: &str, rel: &str) -> String {
    let base = remote_path.trim_end_matches('/');
    let rel = rel.trim_start_matches('/');
    if rel.is_empty() {
        if base.is_empty() {
            "/".to_string()
        } else {
            base.to_string()
        }
    } else if base.is_empty() {
        format!("/{rel}")
    } else {
        format!("{base}/{rel}")
    }
}

/// Map one SFTP [`Entry`](crate::services::sftp::Entry) into a `FileEntry`. The
/// `path` is the **absolute remote path** (`remote_dir`/name) so the frontend's
/// existing absolute-path model keeps working during the sshfs→SFTP transition.
/// `extension`/`mime` come from the file name (as the local lister does);
/// `created_secs` is unavailable over SFTP.
fn remote_file_entry(remote_dir: &str, e: crate::services::sftp::Entry) -> FileEntry {
    let path = format!("{}/{}", remote_dir.trim_end_matches('/'), e.name);
    let ext = Path::new(&e.name)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| format!(".{s}"));
    let mime = ext.as_deref().map(mime_for_ext);
    FileEntry {
        name: e.name,
        path,
        is_dir: e.is_dir,
        size: e.size,
        modified_secs: e.modified_secs,
        created_secs: None,
        extension: ext,
        mime,
    }
}

// ── Remote (SFTP) file I/O dispatch (mount-free remote, Phase 3) ────────────
//
// Each remote operation is pooled-session-first with a one-shot fallback — the
// I/O analogue of `list_dir_remote`. Confinement is the remote counterpart of
// the local `confine_abs`/`enforce_confinement`: a project-relative path is
// validated to stay under the project root (no `..`/absolute escape), and an
// absolute remote path must resolve at or under `spec.remote_path`.

type RemoteTarget = crate::services::remote::RemoteTarget;
type RemotePoolState = crate::services::remote::RemotePoolState;

/// Resolve a project-relative path under a remote project root, rejecting
/// `..`/absolute traversal — the remote analogue of `canonical` + relative
/// `enforce_confinement`. Reuses `normalize_project_rel_path` (which rejects
/// `..`/root components and strips a leading `/`), then joins onto the root.
pub(crate) fn remote_join_confined(remote_root: &str, rel_path: &str) -> Result<String, String> {
    let clean = normalize_project_rel_path(rel_path)?;
    Ok(join_remote_dir(remote_root, &clean))
}

/// Confine an **absolute** remote path to the project's remote root: reject any
/// parent-directory component and require the path to sit at or under
/// `remote_root` on a path boundary (so `/srv/proj-evil` is NOT inside
/// `/srv/proj`). The remote analogue of `confine_abs_within`. Pure, unit-tested.
fn confine_remote_abs(remote_root: &str, path: &str) -> Result<(), String> {
    if Path::new(path)
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(format!(
            "remote path '{path}' contains a parent-directory component"
        ));
    }
    let root = remote_root.trim_end_matches('/');
    let p = path.trim_end_matches('/');
    let inside = root.is_empty() // remote_path "/" → the whole remote fs is the root
        || p == root
        || p.strip_prefix(root).is_some_and(|rest| rest.starts_with('/'));
    if inside {
        Ok(())
    } else {
        Err(format!(
            "remote path '{path}' is outside the project root '{remote_root}'"
        ))
    }
}

/// Clone the pooled SFTP session for the target's project, or `None` (cold pool).
async fn pooled(
    pool: &RemotePoolState,
    target: &RemoteTarget,
) -> Option<std::sync::Arc<openssh_sftp_client::Sftp>> {
    crate::services::remote::pooled_sftp(pool, &target.project_id).await
}

pub(crate) async fn remote_read(
    pool: &RemotePoolState,
    target: &RemoteTarget,
    path: &str,
) -> Result<Vec<u8>, String> {
    let s = &target.spec;
    match pooled(pool, target).await {
        Some(sftp) => crate::services::sftp::read_file_on(&sftp, path).await,
        None => crate::services::sftp::read_file(&s.user, &s.host, s.port, None, path).await,
    }
}

async fn remote_write(
    pool: &RemotePoolState,
    target: &RemoteTarget,
    path: &str,
    bytes: &[u8],
) -> Result<(), String> {
    let s = &target.spec;
    match pooled(pool, target).await {
        Some(sftp) => crate::services::sftp::write_file_on(&sftp, path, bytes).await,
        None => {
            crate::services::sftp::write_file(&s.user, &s.host, s.port, None, path, bytes).await
        }
    }
}

async fn remote_create_file(
    pool: &RemotePoolState,
    target: &RemoteTarget,
    path: &str,
) -> Result<(), String> {
    let s = &target.spec;
    match pooled(pool, target).await {
        Some(sftp) => crate::services::sftp::create_file_on(&sftp, path).await,
        None => crate::services::sftp::create_file(&s.user, &s.host, s.port, None, path).await,
    }
}

async fn remote_mkdir(
    pool: &RemotePoolState,
    target: &RemoteTarget,
    path: &str,
) -> Result<(), String> {
    let s = &target.spec;
    match pooled(pool, target).await {
        Some(sftp) => crate::services::sftp::mkdir_on(&sftp, path).await,
        None => crate::services::sftp::mkdir(&s.user, &s.host, s.port, None, path).await,
    }
}

async fn remote_remove_file(
    pool: &RemotePoolState,
    target: &RemoteTarget,
    path: &str,
) -> Result<(), String> {
    let s = &target.spec;
    match pooled(pool, target).await {
        Some(sftp) => crate::services::sftp::remove_file_on(&sftp, path).await,
        None => crate::services::sftp::remove_file(&s.user, &s.host, s.port, None, path).await,
    }
}

async fn remote_remove_dir(
    pool: &RemotePoolState,
    target: &RemoteTarget,
    path: &str,
) -> Result<(), String> {
    let s = &target.spec;
    match pooled(pool, target).await {
        Some(sftp) => crate::services::sftp::remove_dir_on(&sftp, path).await,
        None => crate::services::sftp::remove_dir(&s.user, &s.host, s.port, None, path).await,
    }
}

async fn remote_rename(
    pool: &RemotePoolState,
    target: &RemoteTarget,
    from: &str,
    to: &str,
) -> Result<(), String> {
    let s = &target.spec;
    match pooled(pool, target).await {
        Some(sftp) => crate::services::sftp::rename_on(&sftp, from, to).await,
        None => crate::services::sftp::rename(&s.user, &s.host, s.port, None, from, to).await,
    }
}

async fn remote_metadata(
    pool: &RemotePoolState,
    target: &RemoteTarget,
    path: &str,
) -> Result<(u64, Option<u64>), String> {
    let s = &target.spec;
    match pooled(pool, target).await {
        Some(sftp) => crate::services::sftp::metadata_on(&sftp, path).await,
        None => crate::services::sftp::metadata(&s.user, &s.host, s.port, None, path).await,
    }
}

// Offload a blocking local-fs body to a worker thread. The full recursive
// walks (Ctrl+P/QuickOpen), tree copies/moves, external imports, and archive
// extraction below all do work proportional to tree/archive size; run inline
// they blocked the main thread — the freeze class `commands::git`'s
// off-thread note describes. The sync bodies stay directly
// unit-testable.

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn list_project_endings(project_dir: String) -> Result<Vec<String>, String> {
    app_core::rt::try_blocking("fs", move || list_project_endings_blocking(project_dir)).await
}

pub fn list_project_endings_blocking(project_dir: String) -> Result<Vec<String>, String> {
    let root = canonical(&project_dir)?;
    let mut endings = BTreeSet::new();
    collect_project_endings(&root, &root, 0, &mut endings)?;
    Ok(endings.into_iter().collect())
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn list_project_paths(project_dir: String) -> Result<Vec<ProjectPathEntry>, String> {
    app_core::rt::try_blocking("fs", move || list_project_paths_blocking(project_dir)).await
}

pub fn list_project_paths_blocking(project_dir: String) -> Result<Vec<ProjectPathEntry>, String> {
    let root = canonical(&project_dir)?;
    let mut paths = Vec::new();
    collect_project_paths(&root, &root, "", 0, &mut paths)?;
    paths.sort_by_key(|entry| (!entry.is_dir, entry.path.to_lowercase()));
    Ok(paths)
}

/// Validate that `new_name` is a bare file name (no separators, not `.`/`..`),
/// returning the trimmed name. Shared by the local and remote rename paths.
fn validate_bare_name(new_name: &str) -> Result<String, String> {
    let trimmed = new_name.trim();
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains('\0')
    {
        return Err(format!("invalid file name '{trimmed}'"));
    }
    Ok(trimmed.to_string())
}

/// Rename a file or directory — path must stay inside the project root.
/// `new_name` must be a bare file name; renames never move entries between
/// directories. Remote projects (mount-free, Phase 3) rename over SFTP; local
/// projects keep the byte-identical local behavior.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn rename_path(
    project_dir: String,
    old_rel: String,
    new_name: String,
    ctx: Ctx,
) -> Result<(), String> {
    let pool = ctx.get::<RemotePoolState>();
    let name = validate_bare_name(&new_name)?;
    if let Some(target) = crate::services::remote::remote_target_for_dir(&project_dir) {
        let from = remote_join_confined(&target.spec.remote_path, &old_rel)?;
        // Rename in place: keep `from`'s directory, swap the final component.
        let to = match from.rfind('/') {
            Some(i) => format!("{}/{}", &from[..i], name),
            None => name.clone(),
        };
        return remote_rename(pool, &target, &from, &to).await;
    }
    app_core::rt::try_blocking("fs", move || rename_path_local(&project_dir, &old_rel, &new_name)).await
}

/// Local-fs rename — the pre-Phase-3 body, byte-identical. Re-validates so it is
/// directly callable in tests.
pub fn rename_path_local(project_dir: &str, old_rel: &str, new_name: &str) -> Result<(), String> {
    let new_name = validate_bare_name(new_name)?;

    let root = canonical(project_dir)?;
    let old = canonical(root.join(old_rel).to_string_lossy().as_ref())?;
    enforce_confinement(&root, &old)?;

    let new = old.parent().ok_or("no parent")?.join(&new_name);
    // New path must also stay inside root.
    let new_c = canonical_or_new(&new)?;
    enforce_confinement(&root, &new_c)?;

    fs::rename(&old, &new).map_err(|e| e.to_string())
}

/// Delete a file — never a directory (safety: use trash or explicit confirm for dirs).
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn delete_file(
    project_dir: String,
    rel_path: String,
    ctx: Ctx,
) -> Result<(), String> {
    let pool = ctx.get::<RemotePoolState>();
    if let Some(target) = crate::services::remote::remote_target_for_dir(&project_dir) {
        let full = remote_join_confined(&target.spec.remote_path, &rel_path)?;
        return remote_remove_file(pool, &target, &full).await;
    }
    app_core::rt::try_blocking("fs", move || delete_file_local(&project_dir, &rel_path)).await
}

/// Local-fs file delete — byte-identical pre-Phase-3 body.
pub fn delete_file_local(project_dir: &str, rel_path: &str) -> Result<(), String> {
    let root = canonical(project_dir)?;
    let target = canonical(root.join(rel_path).to_string_lossy().as_ref())?;
    enforce_confinement(&root, &target)?;

    if target.is_dir() {
        return Err("use delete_dir for directories".to_string());
    }
    fs::remove_file(&target).map_err(|e| e.to_string())
}

/// Delete a directory tree inside the project root.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn delete_dir(
    project_dir: String,
    rel_path: String,
    ctx: Ctx,
) -> Result<(), String> {
    let pool = ctx.get::<RemotePoolState>();
    if let Some(target) = crate::services::remote::remote_target_for_dir(&project_dir) {
        let clean = normalize_project_rel_path(&rel_path)?;
        if clean.is_empty() {
            return Err("refusing to delete project root".to_string());
        }
        let full = join_remote_dir(&target.spec.remote_path, &clean);
        return remote_remove_dir(pool, &target, &full).await;
    }
    // A whole tree goes: on a worker, never the thread driving the command.
    app_core::rt::try_blocking("fs", move || delete_dir_local(&project_dir, &rel_path)).await
}

/// Local-fs directory-tree delete — byte-identical pre-Phase-3 body.
pub fn delete_dir_local(project_dir: &str, rel_path: &str) -> Result<(), String> {
    let root = canonical(project_dir)?;
    let target = canonical(root.join(rel_path).to_string_lossy().as_ref())?;
    enforce_confinement(&root, &target)?;

    if target == root {
        return Err("refusing to delete project root".to_string());
    }
    if !target.is_dir() {
        return Err("use delete_file for files".to_string());
    }
    fs::remove_dir_all(&target).map_err(|e| e.to_string())
}

/// Create a new empty file inside the project.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn create_file(
    project_dir: String,
    rel_path: String,
    ctx: Ctx,
) -> Result<(), String> {
    let pool = ctx.get::<RemotePoolState>();
    if let Some(target) = crate::services::remote::remote_target_for_dir(&project_dir) {
        let full = remote_join_confined(&target.spec.remote_path, &rel_path)?;
        return remote_create_file(pool, &target, &full).await;
    }
    app_core::rt::try_blocking("fs", move || create_file_local(&project_dir, &rel_path)).await
}

/// Local-fs empty-file create, confined like every project write.
pub fn create_file_local(project_dir: &str, rel_path: &str) -> Result<(), String> {
    let root = canonical(project_dir)?;
    let target = root.join(rel_path);
    let target_c = canonical_or_new(&target)?;
    enforce_confinement(&root, &target_c)?;
    write_confined(&target_c, &[])
}

/// Write a text file inside the project.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn write_project_file(
    project_dir: String,
    rel_path: String,
    content: String,
    ctx: Ctx,
) -> Result<(), String> {
    let pool = ctx.get::<RemotePoolState>();
    if let Some(target) = crate::services::remote::remote_target_for_dir(&project_dir) {
        let full = remote_join_confined(&target.spec.remote_path, &rel_path)?;
        return remote_write(pool, &target, &full, content.as_bytes()).await;
    }
    app_core::rt::try_blocking("fs", move || write_project_file_local(&project_dir, &rel_path, &content)).await
}

/// Local-fs text write, confined like every project write.
pub fn write_project_file_local(
    project_dir: &str,
    rel_path: &str,
    content: &str,
) -> Result<(), String> {
    let root = canonical(project_dir)?;
    let target = root.join(rel_path);
    let target_c = canonical_or_new(&target)?;
    enforce_confinement(&root, &target_c)?;
    write_confined(&target_c, content.as_bytes())
}

/// Write raw bytes to a file inside the project (used for drag-and-drop uploads).
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn write_project_file_bytes(
    project_dir: String,
    rel_path: String,
    content: Vec<u8>,
    ctx: Ctx,
) -> Result<(), String> {
    let pool = ctx.get::<RemotePoolState>();
    if let Some(target) = crate::services::remote::remote_target_for_dir(&project_dir) {
        let full = remote_join_confined(&target.spec.remote_path, &rel_path)?;
        return remote_write(pool, &target, &full, &content).await;
    }
    app_core::rt::try_blocking("fs", move || write_project_file_bytes_local(&project_dir, &rel_path, &content)).await
}

/// Local-fs byte write, confined like every project write.
pub fn write_project_file_bytes_local(
    project_dir: &str,
    rel_path: &str,
    content: &[u8],
) -> Result<(), String> {
    let root = canonical(project_dir)?;
    let target = root.join(rel_path);
    let target_c = canonical_or_new(&target)?;
    enforce_confinement(&root, &target_c)?;
    write_confined(&target_c, content)
}

/// Add (`"ignore"`) or drop (`"unignore"`) the `.gitignore` rule for one path
/// of the project. Reads and writes the project's `.gitignore`, so on a worker.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn update_gitignore_rule(
    project_dir: String,
    rel_path: String,
    is_dir: bool,
    action: String,
) -> Result<(), String> {
    app_core::rt::try_blocking("fs", move || update_gitignore_rule_blocking(project_dir, rel_path, is_dir, action)).await
}

pub fn update_gitignore_rule_blocking(
    project_dir: String,
    rel_path: String,
    is_dir: bool,
    action: String,
) -> Result<(), String> {
    // A read-modify-write of one file: two rule edits at once (they no longer
    // queue on the window's thread) would each write their own copy and drop
    // the other's rule.
    static GITIGNORE_EDIT: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _edit = GITIGNORE_EDIT.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let root = canonical(&project_dir)?;
    let clean_rel = normalize_project_rel_path(&rel_path)?;
    let target_c = canonical_or_new(&root.join(&clean_rel))?;
    enforce_confinement(&root, &target_c)?;

    let gitignore_path = root.join(".gitignore");
    // A committed `.gitignore` link or FIFO is refused, never followed.
    let existing = crate::commands::projects::read_project_gitignore(&gitignore_path).map_err(|e| e.to_string())?;
    let create = existing.is_none();
    let existing = existing.unwrap_or_default();
    let mut lines: Vec<String> = existing.lines().map(|line| line.to_string()).collect();
    let new_rules = match action.as_str() {
        "ignore" => gitignore_ignore_rules(&clean_rel, is_dir),
        "unignore" => gitignore_unignore_rules(&clean_rel, is_dir),
        other => return Err(format!("unknown gitignore action: {other}")),
    };
    let inverse_rules = match action.as_str() {
        "ignore" => gitignore_unignore_rules(&clean_rel, is_dir),
        "unignore" => gitignore_ignore_rules(&clean_rel, is_dir),
        _ => Vec::new(),
    };

    lines.retain(|line| {
        let trimmed = line.trim();
        !new_rules.iter().any(|rule| rule == trimmed)
            && !inverse_rules.iter().any(|rule| rule == trimmed)
    });
    if !lines.is_empty() && lines.last().is_some_and(|line| !line.trim().is_empty()) {
        lines.push(String::new());
    }
    lines.extend(new_rules);
    let mut next = lines.join("\n");
    if !next.is_empty() {
        next.push('\n');
    }
    crate::commands::projects::write_no_follow(&gitignore_path, next.as_bytes(), create).map_err(|e| e.to_string())
}

/// Create a new directory inside the project.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn create_dir(
    project_dir: String,
    rel_path: String,
    ctx: Ctx,
) -> Result<(), String> {
    let pool = ctx.get::<RemotePoolState>();
    if let Some(target) = crate::services::remote::remote_target_for_dir(&project_dir) {
        let full = remote_join_confined(&target.spec.remote_path, &rel_path)?;
        return remote_mkdir(pool, &target, &full).await;
    }
    app_core::rt::try_blocking("fs", move || create_dir_local(&project_dir, &rel_path)).await
}

/// Local-fs directory create, confined like every project write.
pub fn create_dir_local(project_dir: &str, rel_path: &str) -> Result<(), String> {
    let root = canonical(project_dir)?;
    let target = root.join(rel_path);
    let target_c = canonical_or_new(&target)?;
    enforce_confinement(&root, &target_c)?;
    fs::create_dir_all(&target_c).map_err(|e| e.to_string())
}

/// Copy a file or directory tree into another location. Both ends are confined
/// to their respective project roots (which may be the same project, enabling an
/// in-project copy/paste, or two box-co-accessible projects). The destination
/// must not already exist, and a directory may not be copied into itself.
/// Links below the copied folder are recreated as links and never followed;
/// what could not be copied (pipes, sockets, devices) comes back in the report.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn copy_path(
    src_project_dir: String,
    src_rel: String,
    dest_project_dir: String,
    dest_rel: String,
) -> Result<CopyReport, String> {
    app_core::rt::try_blocking("fs", move || copy_path_blocking(src_project_dir, src_rel, dest_project_dir, dest_rel))
        .await
}

pub fn copy_path_blocking(
    src_project_dir: String,
    src_rel: String,
    dest_project_dir: String,
    dest_rel: String,
) -> Result<CopyReport, String> {
    let (src, dest) = resolve_transfer(&src_project_dir, &src_rel, &dest_project_dir, &dest_rel)?;
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    copy_tree(&src, &dest).map_err(|e| e.to_string())
}

/// Move (cut/paste) a file or directory tree into another location. Same
/// confinement and pre-conditions as [`copy_path`]. Falls back to copy+remove
/// only when the rename failed because source and destination are on different
/// filesystems/volumes; any other rename error is returned as it is.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn move_path(
    src_project_dir: String,
    src_rel: String,
    dest_project_dir: String,
    dest_rel: String,
) -> Result<(), String> {
    app_core::rt::try_blocking("fs", move || move_path_blocking(src_project_dir, src_rel, dest_project_dir, dest_rel))
        .await
}

pub fn move_path_blocking(
    src_project_dir: String,
    src_rel: String,
    dest_project_dir: String,
    dest_rel: String,
) -> Result<(), String> {
    let (src, dest) = resolve_transfer(&src_project_dir, &src_rel, &dest_project_dir, &dest_rel)?;
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    match fs::rename(&src, &dest) {
        Ok(()) => return Ok(()),
        // Only a cross-device rename is answered with copy-then-delete. A file
        // held open (Windows), a permission refusal or a protected folder would
        // otherwise leave a full copy at the destination and the original in
        // place — a duplicate, reported as an error only after the copy.
        Err(e) if !crate::paths::is_cross_device(&e) => {
            return Err(format!("could not move: {e}"));
        }
        Err(_) => {}
    }
    let report = copy_tree(&src, &dest).map_err(|e| e.to_string())?;
    if report.skipped_count > 0 {
        // The original holds what the copy left out: removing it would lose that.
        crate::services::tree_copy::discard(&dest);
        return Err(format!(
            "could not move across drives: {} item(s) cannot be copied ({}); the original was left in place",
            report.skipped_count,
            report.summary()
        ));
    }
    let remove = if src.is_dir() {
        fs::remove_dir_all(&src)
    } else {
        fs::remove_file(&src)
    };
    remove.map_err(|e| e.to_string())
}

/// Import an external file or directory (dropped onto the side panel from the
/// OS file manager) into the project. Unlike [`copy_path`], the SOURCE is an
/// arbitrary absolute path outside the project, so it is not confined; only the
/// DESTINATION is confined to the project root. `dest_rel` is the project-
/// relative folder to drop into (empty = project root). On a name collision,
/// `replace=false` appends " (n)" before the extension (keep both); `replace=
/// true` overwrites the existing entry. Returns the final project-relative path
/// of the imported copy. Callers prompt the user (see `project_path_exists`)
/// before passing `replace=true`.
///
/// `dest_name` renames the copy on the way in — the collision prompt's "keep
/// both, as <name>", where the user names the second copy instead of accepting
/// " (n)". It is the *name* only, never a path (see `validate_import_name`), so
/// it can redirect the copy within the dropped-on folder and nowhere else; and
/// it still goes through `unique_dest` unless `replace`, so a chosen name that
/// also collides is suffixed rather than overwriting something.
///
/// `expected_size` is set for a source path an OS drop's frontend inferred
/// (`parseDroppedFiles`: WebKitGTK leaks only the first path of a multi-file
/// drop): it is imported only if it is a regular file of the dropped `File`'s
/// size, so a same-named file in the wrong folder is never copied.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn import_external_file(
    project_dir: String,
    source_path: String,
    dest_rel: String,
    replace: bool,
    dest_name: Option<String>,
    expected_size: Option<u64>,
) -> Result<String, String> {
    app_core::rt::try_blocking("fs", move || {
        if let Some(size) = expected_size {
            check_inferred_drop(&source_path, size)?;
        }
        import_external_file_blocking(project_dir, source_path, dest_rel, replace, dest_name)
    })
    .await
}

fn check_inferred_drop(source_path: &str, size: u64) -> Result<(), String> {
    match fs::metadata(source_path) {
        Ok(meta) if meta.is_file() && meta.len() == size => Ok(()),
        _ => Err("the dropped file is not where it was inferred to be".to_string()),
    }
}

pub fn import_external_file_blocking(
    project_dir: String,
    source_path: String,
    dest_rel: String,
    replace: bool,
    dest_name: Option<String>,
) -> Result<String, String> {
    let src = canonical(&source_path)?;
    let root = canonical(&project_dir)?;

    let rel_dir = normalize_project_rel_path(&dest_rel)?;
    let dest_dir = if rel_dir.is_empty() {
        root.clone()
    } else {
        root.join(&rel_dir)
    };
    let dest_dir_c = canonical_or_new(&dest_dir)?;
    enforce_confinement(&root, &dest_dir_c)?;
    // Block copying a directory into its own subtree (would recurse forever).
    if dest_dir_c.starts_with(&src) {
        return Err("cannot copy a folder into itself".to_string());
    }

    let source_name = src
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| "source has no file name".to_string())?;
    let file_name = match dest_name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        Some(n) => validate_import_name(n)?,
        None => source_name,
    };
    let dest = if replace {
        dest_dir_c.join(&file_name)
    } else {
        unique_dest(&dest_dir_c, &file_name)
    };
    enforce_confinement(&root, &canonical_or_new(&dest)?)?;

    fs::create_dir_all(&dest_dir_c).map_err(|e| e.to_string())?;
    if replace && dest.exists() {
        // Clear the existing entry first so a file→dir (or dir→file) replace is
        // clean rather than merging into a stale tree.
        if dest.is_dir() {
            fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
        } else {
            fs::remove_file(&dest).map_err(|e| e.to_string())?;
        }
    }
    let report = copy_tree(&src, &dest).map_err(|e| e.to_string())?;
    if report.skipped_count > 0 {
        eprintln!("import: {} item(s) not copied from the dropped folder: {}", report.skipped_count, report.summary());
    }

    Ok(dest
        .strip_prefix(&root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or(file_name))
}

/// Whether a project-relative path currently exists. The drag-drop importer
/// calls this before copying so it can prompt rename-vs-replace on a collision.
/// It canonicalizes inside the project tree, so on a worker.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn project_path_exists(project_dir: String, rel_path: String) -> Result<bool, String> {
    app_core::rt::try_blocking("fs", move || project_path_exists_blocking(project_dir, rel_path)).await
}

pub fn project_path_exists_blocking(project_dir: String, rel_path: String) -> Result<bool, String> {
    let root = canonical(&project_dir)?;
    let rel = normalize_project_rel_path(&rel_path)?;
    let target = if rel.is_empty() {
        root.clone()
    } else {
        root.join(&rel)
    };
    let target_c = canonical_or_new(&target)?;
    enforce_confinement(&root, &target_c)?;
    Ok(target_c.exists())
}

/// Extract a `.zip` archive in place. Contents land in a new sibling folder
/// named after the archive (without its extension, deduped with " (n)"), inside
/// the same directory as the archive — so a double-click in the file tree never
/// dumps loose files over the current folder. Returns the project-relative path
/// of the created folder.
///
/// Security: guards against Zip-Slip. Every entry's path goes through
/// `enclosed_name` (which rejects `..`/absolute components), and the resolved
/// output is additionally confined to the destination folder before any write.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn extract_archive(project_dir: String, rel_path: String) -> Result<String, String> {
    app_core::rt::try_blocking("fs", move || extract_archive_blocking(project_dir, rel_path)).await
}

pub fn extract_archive_blocking(project_dir: String, rel_path: String) -> Result<String, String> {
    let root = canonical(&project_dir)?;
    let archive = canonical(root.join(&rel_path).to_string_lossy().as_ref())?;
    enforce_confinement(&root, &archive)?;
    if !archive.is_file() {
        return Err("not a file".to_string());
    }

    let parent = archive
        .parent()
        .ok_or("archive has no parent directory")?
        .to_path_buf();
    let stem = archive
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "archive has no name".to_string())?;
    // Reuse the " (n)" collision suffixing — `stem` has no extension, so the
    // suffix simply lands at the end of the folder name.
    let dest_dir = unique_dest(&parent, &stem);
    enforce_confinement(&root, &canonical_or_new(&dest_dir)?)?;

    let file = fs::File::open(&archive).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("read zip: {e}"))?;
    fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;

    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        // `enclosed_name` returns None for any path that would escape the
        // destination (`..`, absolute, drive prefix) — skip those rather than
        // trusting the archive.
        let rel = match entry.enclosed_name() {
            Some(p) => p,
            None => continue,
        };
        let out = dest_dir.join(&rel);
        // Defense in depth: confine the resolved output to the dest folder.
        enforce_confinement(&dest_dir, &canonical_or_new(&out)?)?;
        if entry.is_dir() {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        } else {
            if let Some(p) = out.parent() {
                fs::create_dir_all(p).map_err(|e| e.to_string())?;
            }
            let mut outfile = fs::File::create(&out).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut outfile).map_err(|e| e.to_string())?;
        }
    }

    Ok(dest_dir
        .strip_prefix(&root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or(stem))
}

/// Pick a non-colliding destination path in `dir` for `file_name`, appending
/// " (1)", " (2)", … before the extension until a free name is found.
/// A caller-chosen import name is one path component and nothing else. A
/// separator would place the copy outside the folder that was dropped onto,
/// and `.`/`..` name a directory rather than a new entry in it — so both are
/// refused here, before `enforce_confinement` gets a chance to be the only
/// thing standing between a typed name and an arbitrary write.
fn validate_import_name(name: &str) -> Result<String, String> {
    if name.contains('/') || name.contains('\\') || name == "." || name == ".." {
        return Err(format!("invalid file name: {name}"));
    }
    Ok(name.to_string())
}

fn unique_dest(dir: &Path, file_name: &str) -> PathBuf {
    let direct = dir.join(file_name);
    if !direct.exists() {
        return direct;
    }
    // A leading-dot name with no other dot (".gitignore") has no extension, so
    // `stem` keeps the whole name and the suffix lands at the end.
    let ext = Path::new(file_name).extension().and_then(|e| e.to_str());
    let stem = match ext {
        Some(e) => &file_name[..file_name.len() - e.len() - 1],
        None => file_name,
    };
    for n in 1..10_000 {
        let candidate = match ext {
            Some(e) => format!("{stem} ({n}).{e}"),
            None => format!("{stem} ({n})"),
        };
        let p = dir.join(candidate);
        if !p.exists() {
            return p;
        }
    }
    direct
}

/// Validate and resolve a copy/move: confine both ends, refuse an existing
/// destination, a no-op, and copying a directory into its own subtree.
fn resolve_transfer(
    src_project_dir: &str,
    src_rel: &str,
    dest_project_dir: &str,
    dest_rel: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let src_root = canonical(src_project_dir)?;
    let src = canonical(src_root.join(src_rel).to_string_lossy().as_ref())?;
    enforce_confinement(&src_root, &src)?;
    if src == src_root {
        return Err("refusing to copy the project root".to_string());
    }

    let dest_root = canonical(dest_project_dir)?;
    let dest = dest_root.join(dest_rel);
    let dest_c = canonical_or_new(&dest)?;
    enforce_confinement(&dest_root, &dest_c)?;

    if dest_c.exists() {
        return Err(format!("'{}' already exists", dest.display()));
    }
    if dest_c == src {
        return Err("source and destination are the same".to_string());
    }
    // Block copying a directory into its own subtree (would recurse forever).
    if dest_c.starts_with(&src) {
        return Err("cannot copy a folder into itself".to_string());
    }
    Ok((src, dest))
}

// ── Viewer source classification (remote-native vs local mirror) ──────────

/// Classify where an in-app viewer's bytes come from, for the viewer's source
/// notice. Returns exactly one of:
///   - `"remote"` — a remote (SSH) project path served straight from the host
///     over SFTP (remote-native, no local copy).
///   - `"local"`  — a remote project path under the local **mirror**, read on the
///     LOCAL fs (the paired working copy synced from the host).
///   - `"none"`   — a local project (or root scope): there is no remote/local
///     distinction, so the frontend shows no badge.
///
/// This mirrors the *exact* routing `read_file_text`/`read_file_bytes` apply
/// (`remote_target_for` gates remoteness, `is_under_mirror` picks the side), so
/// the badge can never disagree with where the bytes were actually read from.
/// The side is found by canonicalizing both paths, so on a worker; a worker
/// that fails answers "none" (no badge).
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn file_source(path: String, project_id: Option<String>) -> String {
    app_core::rt::blocking("fs", move || file_source_blocking(path, project_id))
        .await
        .unwrap_or_else(|_| "none".to_string())
}

fn file_source_blocking(path: String, project_id: Option<String>) -> String {
    match project_id.as_deref() {
        Some(pid) if crate::services::remote::remote_target_for(pid).is_some() => {
            if crate::services::remote_sync::is_under_mirror(pid, &path) {
                "local".to_string()
            } else {
                "remote".to_string()
            }
        }
        _ => "none".to_string(),
    }
}

// ── Read file contents for in-app viewers (Group K #40) ───────────────────

/// Largest text file we will load into an in-app viewer (8 MiB). Larger files
/// are refused rather than risking a multi-MB string crossing the IPC bridge.
const MAX_TEXT_VIEW_BYTES: u64 = 8 * 1024 * 1024;
/// Largest binary (PDF) we will load into the in-app viewer.
///
/// This used to be 64 MiB, and the number was doing two jobs at once: it bounded
/// what the renderer would hold, *and* it stood in for the fact that bytes crossed
/// the IPC bridge as a **JSON array of numbers** — one decimal literal per byte. A
/// 64 MiB file was therefore ~200 MB of JSON to serialize, parse, and materialize as
/// a 67-million-element JS array before a single page could be drawn, so the limit
/// was really the point at which that transport stopped being survivable rather than
/// a statement about the document.
///
/// `read_file_bytes`/`write_file_bytes` now use Tauri's **raw** IPC body
/// (`ipc::Response` / `ipc::Request`), i.e. an `ArrayBuffer` straight across with no
/// text encoding in between, which removes that cost entirely and leaves only the
/// honest question: how large a file may the webview hold? A PDF is held twice while
/// open (the buffer pdf.js parses, plus its own internal copy), so this is set where
/// a real document — a figure-heavy LaTeX thesis is the case that forced it — opens
/// while a pathological one is still refused rather than taking the renderer down.
const MAX_BINARY_VIEW_BYTES: u64 = 256 * 1024 * 1024;

/// Read an absolute file path as UTF-8 text for the in-app text/markdown viewer.
///
/// Takes an absolute path (the same `FileEntry.path` the file tree already uses
/// to open files). Security #1: the path is confined to Tabtivity's known roots
/// (`~/tabtivity`, the sshfs mounts dir, the state dir) so a content-injection in
/// a renderer cannot turn this into an arbitrary file read of e.g.
/// `~/.ssh/id_rsa`. Refuses files over `MAX_TEXT_VIEW_BYTES` and non-UTF-8
/// (binary) files.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn read_file_text(
    path: String,
    project_id: Option<String>,
    ctx: Ctx,
) -> Result<String, String> {
    let pool = ctx.get::<RemotePoolState>();
    if let Some(pid) = project_id.as_deref() {
        if let Some(target) = crate::services::remote::remote_target_for(pid) {
            // SSH-sync G2: a path under the local mirror is read on the LOCAL fs
            // even for a remote project, so the local source view / local-on-remote
            // tabs see mirrored bytes instead of round-tripping SFTP.
            if !crate::services::remote_sync::is_under_mirror(pid, &path) {
                confine_remote_abs(&target.spec.remote_path, &path)?;
                let (size, _) = remote_metadata(pool, &target, &path).await?;
                if size > MAX_TEXT_VIEW_BYTES {
                    return Err(format!(
                        "file too large to view ({size} bytes; limit {MAX_TEXT_VIEW_BYTES})"
                    ));
                }
                let bytes = remote_read(pool, &target, &path).await?;
                return String::from_utf8(bytes)
                    .map_err(|_| "file is not valid UTF-8 text".to_string());
            }
        }
    }
    read_file_text_local(&path, project_id.as_deref())
}

/// Local-fs text read through [`open_confined`] (an in-root link still reads).
pub fn read_file_text_local(path: &str, scope_id: Option<&str>) -> Result<String, String> {
    let p = PathBuf::from(path);
    let file = open_confined(&p, &allowed_roots(scope_id), Confined::Read)?;
    let bytes = read_opened(file, MAX_TEXT_VIEW_BYTES)?;
    String::from_utf8(bytes).map_err(|_| "file is not valid UTF-8 text".to_string())
}

/// Write UTF-8 text to an absolute file path from the in-app editor.
///
/// Counterpart to `read_file_text`: same absolute `FileEntry.path`, confined to
/// Tabtivity's known roots (Security #1 — without it any reachable IPC caller could
/// overwrite arbitrary user files), refuses to grow a file past
/// `MAX_TEXT_VIEW_BYTES`, and only writes to an existing regular file (the
/// editor edits files opened from the tree; it never creates new paths).
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn write_file_text(
    path: String,
    content: String,
    project_id: Option<String>,
    ctx: Ctx,
) -> Result<(), String> {
    let pool = ctx.get::<RemotePoolState>();
    if let Some(pid) = project_id.as_deref() {
        if let Some(target) = crate::services::remote::remote_target_for(pid) {
            // SSH-sync G2: a mirror-local path saves to the LOCAL mirror (Phase 2
            // optionally pushes it on to the host through sync_push).
            if !crate::services::remote_sync::is_under_mirror(pid, &path) {
                confine_remote_abs(&target.spec.remote_path, &path)?;
                if content.len() as u64 > MAX_TEXT_VIEW_BYTES {
                    return Err(format!(
                        "content too large to save ({} bytes; limit {})",
                        content.len(),
                        MAX_TEXT_VIEW_BYTES
                    ));
                }
                return remote_write(pool, &target, &path, content.as_bytes()).await;
            }
        }
    }
    write_file_text_local(&path, &content, project_id.as_deref())
}

/// Local-fs text write: an existing regular file only, emptied and rewritten in
/// place through [`open_confined`] — a leaf that is a link is refused (D1).
pub fn write_file_text_local(
    path: &str,
    content: &str,
    scope_id: Option<&str>,
) -> Result<(), String> {
    let p = PathBuf::from(path);
    if content.len() as u64 > MAX_TEXT_VIEW_BYTES {
        return Err(format!(
            "content too large to save ({} bytes; limit {})",
            content.len(),
            MAX_TEXT_VIEW_BYTES
        ));
    }
    let file = open_confined(&p, &allowed_roots(scope_id), Confined::Overwrite)?;
    write_opened(file, content.as_bytes())
}

/// Write raw bytes to an absolute path, confined to Tabtivity's known roots
/// (Security #1). Unlike `write_file_text` this may create a new file (so the
/// image annotator can "Save as…" a sibling PNG), but still refuses paths
/// outside the allowed roots and oversized payloads.
///
/// The bytes arrive as the invoke's **raw body** and the two scalars ride in
/// headers, which is the shape Tauri offers for a binary upload (one raw body per
/// call, so anything alongside it has to be a header). The reason is the read side's
/// in reverse: a JSON argument would have been `Array.from(bytes)` in the renderer —
/// a number array as long as the file, then its JSON text — which for a rebuilt PDF
/// of any size is the renderer-killing step, and the remark autosave would have run
/// straight into it without anyone clicking anything.
///
/// The header values are `encodeURIComponent`-encoded, because a header is ASCII and
/// a path is not: `~/tabtivity/projects/Übung/…` would otherwise be unsendable. Nothing
/// about that is a trust boundary — the decoded path goes through exactly the same
/// confinement (`open_confined`) as before.
#[cfg(feature = "desktop")]
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn write_file_bytes(
    request: tauri::ipc::Request<'_>,
    ctx: Ctx,
) -> Result<(), String> {
    let pool = ctx.get::<RemotePoolState>();
    let path = request_header(&request, crate::brand::FILE_PATH_HEADER)
        .ok_or_else(|| "write_file_bytes: missing path".to_string())?;
    let project_id = request_header(&request, crate::brand::FILE_PROJECT_HEADER).filter(|s| !s.is_empty());
    // The raw body is the whole point of this command. A JSON one is still accepted,
    // because Tauri has a documented fallback (the postMessage interface, used when
    // the custom-protocol IPC is blocked) that carries the headers but re-encodes the
    // payload — and a *save* silently failing there would be the worst possible place
    // to be strict. Anything that is not a byte array is refused rather than written.
    let decoded: Vec<u8>;
    let content: &[u8] = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes,
        tauri::ipc::InvokeBody::Json(value) => {
            decoded = json_byte_array(value)
                .ok_or_else(|| "write_file_bytes: body is not bytes".to_string())?;
            &decoded
        }
    };
    // The deck's figure writes (`NO_FOLDER_LINK_HEADER`): the folder too.
    let own_folder_unlinked = request_header(&request, NO_FOLDER_LINK_HEADER).as_deref() == Some("1");
    write_file_bytes_routed(path, content, project_id, own_folder_unlinked, pool).await
}

/// A JSON array of byte-sized integers as bytes; `None` for anything else.
fn json_byte_array(value: &Value) -> Option<Vec<u8>> {
    let items = value.as_array()?;
    items
        .iter()
        .map(|v| u8::try_from(v.as_u64()?).ok())
        .collect()
}

/// A percent-decoded request header, or `None` when it is absent or not valid UTF-8.
#[cfg(feature = "desktop")]
fn request_header(request: &tauri::ipc::Request<'_>, name: &str) -> Option<String> {
    let raw = request.headers().get(name)?.to_str().ok()?;
    percent_decode(raw)
}

/// Decode an `encodeURIComponent` string. Hand-rolled rather than pulling in a
/// crate: this is the only place a header carries one, and the whole grammar is
/// "%XX is a byte, everything else is itself" (a `+` is a literal here — JS's
/// `encodeURIComponent` never emits one as a space).
fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Route a byte write to the host or the local fs — the pre-raw-IPC body, unchanged
/// except for taking the content by reference (it is borrowed from the request).
async fn write_file_bytes_routed(
    path: String,
    content: &[u8],
    project_id: Option<String>,
    own_folder_unlinked: bool,
    pool: &RemotePoolState,
) -> Result<(), String> {
    if let Some(pid) = project_id.as_deref() {
        if let Some(target) = crate::services::remote::remote_target_for(pid) {
            // SSH-sync G2: a mirror-local path writes to the LOCAL mirror.
            if !crate::services::remote_sync::is_under_mirror(pid, &path) {
                confine_remote_abs(&target.spec.remote_path, &path)?;
                if content.len() as u64 > MAX_BINARY_VIEW_BYTES {
                    return Err(format!(
                        "content too large to save ({} bytes; limit {})",
                        content.len(),
                        MAX_BINARY_VIEW_BYTES
                    ));
                }
                return remote_write(pool, &target, &path, content).await;
            }
        }
    }
    write_file_bytes_local(&path, content, project_id.as_deref(), own_folder_unlinked)
}

/// Local-fs byte write through [`open_confined`]: an existing regular file is
/// rewritten in place, a missing one created `O_EXCL`; a leaf that is a link,
/// dangling or not, is refused and nothing is created at its target (D1).
pub fn write_file_bytes_local(
    path: &str,
    content: &[u8],
    scope_id: Option<&str>,
    own_folder_unlinked: bool,
) -> Result<(), String> {
    let p = PathBuf::from(path);
    if content.len() as u64 > MAX_BINARY_VIEW_BYTES {
        return Err(format!(
            "content too large to save ({} bytes; limit {})",
            content.len(),
            MAX_BINARY_VIEW_BYTES
        ));
    }
    let mode = if own_folder_unlinked { Confined::WriteOwnFolder } else { Confined::Write };
    let file = open_confined(&p, &allowed_roots(scope_id), mode)?;
    write_opened(file, content)
}

/// Read an absolute file path as raw bytes for the in-app PDF viewer.
///
/// Confined to Tabtivity's known roots (Security #1). Refuses files over
/// `MAX_BINARY_VIEW_BYTES`.
///
/// Answers with a **raw** IPC body (`ipc::Response`), not a serialized `Vec<u8>`.
/// That is the whole difference between a large PDF opening and not: a JSON-encoded
/// byte array costs ~3 bytes of text per byte of file and lands in the renderer as a
/// number array that then has to be copied into a `Uint8Array`, so a 130 MB thesis
/// meant roughly 400 MB of JSON and a multi-second freeze of the whole window before
/// pdf.js was even handed anything. A raw body arrives as an `ArrayBuffer` — the
/// bytes, once — which is also why the frontend wrapper hands one straight to pdf.js
/// instead of re-wrapping it.
#[cfg(feature = "desktop")]
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn read_file_bytes(
    path: String,
    project_id: Option<String>,
    ctx: Ctx,
) -> Result<tauri::ipc::Response, String> {
    let pool = ctx.get::<RemotePoolState>();
    read_file_bytes_any(path, project_id, pool)
        .await
        .map(tauri::ipc::Response::new)
}

/// The bytes of `path`, for a host that is not Tauri: a browser's
/// `read_file_bytes` arrives as a binary frame (hosted plan §3.5) and is
/// answered by `mobile_control::web_client` through this, with the same
/// confinement and remote routing as the IPC shape above.
pub async fn read_file_bytes_for(
    ctx: &CoreCtx,
    path: String,
    project_id: Option<String>,
) -> Result<Vec<u8>, String> {
    read_file_bytes_any(path, project_id, ctx.get::<RemotePoolState>()).await
}

/// `write_file_bytes` for a host that is not Tauri (see [`read_file_bytes_for`]).
pub async fn write_file_bytes_for(
    ctx: &CoreCtx,
    path: String,
    content: &[u8],
    project_id: Option<String>,
    own_folder_unlinked: bool,
) -> Result<(), String> {
    write_file_bytes_routed(path, content, project_id, own_folder_unlinked, ctx.get::<RemotePoolState>()).await
}

/// The read itself, kept separate from the IPC shape so the routing stays testable
/// and so a Rust caller is not made to build a `Response` to get at bytes.
async fn read_file_bytes_any(
    path: String,
    project_id: Option<String>,
    pool: &RemotePoolState,
) -> Result<Vec<u8>, String> {
    if let Some(pid) = project_id.as_deref() {
        if let Some(target) = crate::services::remote::remote_target_for(pid) {
            // SSH-sync G2: a mirror-local path reads from the LOCAL mirror.
            if !crate::services::remote_sync::is_under_mirror(pid, &path) {
                confine_remote_abs(&target.spec.remote_path, &path)?;
                let (size, _) = remote_metadata(pool, &target, &path).await?;
                if size > MAX_BINARY_VIEW_BYTES {
                    return Err(format!(
                        "file too large to view ({size} bytes; limit {MAX_BINARY_VIEW_BYTES})"
                    ));
                }
                return remote_read(pool, &target, &path).await;
            }
        }
    }
    read_file_bytes_local(&path, project_id.as_deref())
}

/// Local-fs byte read through [`open_confined`] (an in-root link still reads).
pub fn read_file_bytes_local(path: &str, scope_id: Option<&str>) -> Result<Vec<u8>, String> {
    let p = PathBuf::from(path);
    let file = open_confined(&p, &allowed_roots(scope_id), Confined::Read)?;
    read_opened(file, MAX_BINARY_VIEW_BYTES)
}

/// Return a file's last-modified time as whole seconds since the Unix epoch.
///
/// Used by the in-app text/markdown/TeX viewer to poll for external changes
/// (#43 diff-aware auto-reload). Confined to Tabtivity's known roots (Security #1).
/// Mirrors the `FileEntry.modified_secs` machinery in `list_dir`.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn file_mtime(
    path: String,
    project_id: Option<String>,
    ctx: Ctx,
) -> Result<u64, String> {
    let pool = ctx.get::<RemotePoolState>();
    if let Some(pid) = project_id.as_deref() {
        if let Some(target) = crate::services::remote::remote_target_for(pid) {
            // SSH-sync G2: a mirror-local path is stat'd on the LOCAL fs.
            if !crate::services::remote_sync::is_under_mirror(pid, &path) {
                confine_remote_abs(&target.spec.remote_path, &path)?;
                let (_, modified) = remote_metadata(pool, &target, &path).await?;
                return Ok(modified.unwrap_or(0));
            }
        }
    }
    file_mtime_local(&path, project_id.as_deref())
}

/// Local-fs mtime of a file or folder opened through [`open_confined`].
pub fn file_mtime_local(path: &str, scope_id: Option<&str>) -> Result<u64, String> {
    let p = PathBuf::from(path);
    let meta = open_confined(&p, &allowed_roots(scope_id), Confined::Stat)?
        .metadata()
        .map_err(|e| e.to_string())?;
    Ok(crate::clock::unix_secs(meta.modified().map_err(|e| e.to_string())?))
}

/// Return a file's size in bytes.
///
/// The PDF viewer's companion to `file_mtime`: before re-reading a PDF a
/// compiler is rewriting it stats the size twice, a few hundred ms apart, and
/// reads only once the two agree — a stat instead of a whole-file IPC read per
/// retry of a mid-write parse. Same confinement and remote routing as the mtime.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn file_size(
    path: String,
    project_id: Option<String>,
    ctx: Ctx,
) -> Result<u64, String> {
    let pool = ctx.get::<RemotePoolState>();
    if let Some(pid) = project_id.as_deref() {
        if let Some(target) = crate::services::remote::remote_target_for(pid) {
            if !crate::services::remote_sync::is_under_mirror(pid, &path) {
                confine_remote_abs(&target.spec.remote_path, &path)?;
                let (size, _) = remote_metadata(pool, &target, &path).await?;
                return Ok(size);
            }
        }
    }
    file_size_local(&path, project_id.as_deref())
}

/// Local-fs size, confined like `file_mtime_local`.
pub fn file_size_local(path: &str, scope_id: Option<&str>) -> Result<u64, String> {
    let p = PathBuf::from(path);
    let meta = open_confined(&p, &allowed_roots(scope_id), Confined::Stat)?
        .metadata()
        .map_err(|e| e.to_string())?;
    Ok(meta.len())
}

// ── Absolute-path confinement (Security #1) ────────────────────────────────

/// The set of directories the absolute-path file commands may touch for a given
/// **scope**: the scope project's own directory, plus the directories of any
/// projects that share a box with it. Projects are filesystem-isolated from one
/// another — a file command made on behalf of project X can reach X's tree (and
/// any box sibling's tree, since box members are deliberately co-accessible), and
/// nothing else.
///
/// Crucially the scope is the project that *owns the calling viewer* (passed by
/// the frontend), NOT whichever project is globally "current". In-app viewers
/// stay mounted across project switches, are restored on relaunch, and can live
/// in detached windows; binding confinement to the current project made those
/// fail with a spurious "path is not in the current project" error the moment you
/// switched away (e.g. a `file_mtime` poll or `read_file_text` reload). Binding
/// it to the viewer's own project keeps strict per-project isolation while
/// letting a viewer keep working regardless of which project is current.
///
/// `scope_id` of `None` (root scope, or a caller that supplied no project) falls
/// back to the current project + its box siblings. Returns an empty set when the
/// scope resolves to no project (e.g. first run), which makes every absolute-path
/// command fail closed. See REVIEW.md Security #1.
fn allowed_roots(scope_id: Option<&str>) -> Vec<PathBuf> {
    let projects = PROJECTS.get("projects.json");
    let boxes = BOXES.get("boxes.json");
    compute_allowed_roots(&projects, &boxes, scope_id, &storage::root_work_dir())
}

/// The parsed registries every confinement check reads (see [`StateJsonCache`]).
static PROJECTS: StateJsonCache<ProjectsList> = StateJsonCache::new();
static BOXES: StateJsonCache<BoxesList> = StateJsonCache::new();

/// Every folder a server **user** (`core_dispatch::Role::User`) may name to a
/// command that takes a local path (`core_dispatch::confine_for_user`): the
/// root work dir, the parents new projects and remote mirrors are created
/// under, every project's directory and mirror override, and every box
/// folder. Wider than [`allowed_roots`] on purpose — that one isolates a
/// viewer to its own project; this one is the whole of what the user's
/// projects are, so a folder outside every project (`/`, `/etc`, another
/// account's home) is refused while switching projects is not.
pub(crate) fn user_roots() -> Vec<PathBuf> {
    let projects = PROJECTS.get("projects.json");
    let boxes = BOXES.get("boxes.json");
    let base = [
        storage::root_work_dir(),
        crate::paths::projects_root(),
        crate::paths::projects_ssh_root(),
    ];
    let keep_clear = [crate::paths::home_dir(), crate::paths::app_home(), storage::state_dir()];
    compute_user_roots(&projects, &boxes, &base, &keep_clear)
}

/// Pure core of [`user_roots`]. Each root is resolved as a confinement
/// candidate is (`canonical_or_new`), so a root that does not exist yet still
/// compares equal to a path under it.
///
/// A registered root (a project, mirror or box folder; not a `base` one) is
/// judged by where it resolves *now*, and a user can turn a folder they own
/// into a symlink after registering it (`git_checkout` of a branch holding a
/// link, `move_path` of one over it) — without these two rules, a project
/// folder swapped for a link to `/` made `/` a root. So a registered root is
/// dropped when
/// - any symlink on its spelling (the root itself or an ancestor) sits
///   strictly inside a root, by either spelling: a link there is the user's
///   to plant. A link above every root (`/home` → `/data/home`, macOS's
///   `/var`) is the system's and is followed; or
/// - it resolves to `keep_clear` (home, app home, state dir) or an ancestor of
///   one, whatever the route.
///
/// The cost: a project registered (by an admin or the desktop) through a link
/// inside a root is not one of a user's roots — refused, never widened.
fn compute_user_roots(
    projects: &ProjectsList,
    boxes: &BoxesList,
    base: &[PathBuf],
    keep_clear: &[PathBuf],
) -> Vec<PathBuf> {
    let mut registered: Vec<PathBuf> = projects.iter().filter_map(project_dir).collect();
    registered.extend(projects.iter().filter_map(mirror_override_dir));
    registered.extend(boxes.iter().filter_map(|b| b.folder.as_deref()).map(str::trim).filter(|f| !f.is_empty()).map(PathBuf::from));
    // A relative entry would resolve against the process's cwd, and a `..`
    // makes the spelling a lie about where the link checks look: never a root.
    let usable = |r: &PathBuf| r.is_absolute() && !r.components().any(|c| matches!(c, std::path::Component::ParentDir));
    let base: Vec<PathBuf> = base.iter().filter(|r| usable(r)).cloned().collect();
    registered.retain(usable);
    let resolve = |r: &PathBuf| canonical_or_new(r).unwrap_or_else(|_| r.clone());
    let keep_clear: Vec<PathBuf> = keep_clear.iter().filter(|k| k.is_absolute()).map(resolve).collect();
    let covers_kept = |c: &Path| keep_clear.iter().any(|k| k.starts_with(c));
    let resolved: Vec<(PathBuf, PathBuf)> = registered.iter().map(|r| (r.clone(), resolve(r))).collect();
    // Where a planted link would sit: inside any root, as spelled or resolved
    // (a resolution that covers a kept-clear folder is no fence: it would
    // count every system link as planted).
    let mut fences: Vec<PathBuf> = base.iter().flat_map(|b| [b.clone(), resolve(b)]).collect();
    for (lexical, canonical) in &resolved {
        fences.push(lexical.clone());
        if !covers_kept(canonical) {
            fences.push(canonical.clone());
        }
    }
    let mut roots: Vec<PathBuf> = base.iter().map(resolve).collect();
    roots.extend(
        resolved
            .into_iter()
            .filter(|(lexical, canonical)| !covers_kept(canonical) && !through_planted_link(lexical, &fences))
            .map(|(_, canonical)| canonical),
    );
    roots
}

/// `roots` without any reached through a link planted inside another root,
/// any of `roots` or of `registered` (every registered project, mirror and box
/// folder: a scope's own set is narrower than what an agent can plant a link
/// in). The user-roots rule of [`compute_user_roots`]: a root is **dropped**,
/// never rewritten to its real path, since the fence binds a root at its own
/// path and the viewers compare against what is listed. A root spelled with
/// `..` is dropped too (the link checks read the spelling). A link above every
/// root is the system's and is followed, and a resolution covering one of
/// `keep_clear` (home, state dir) is no fence for the others.
pub(crate) fn drop_planted_roots(roots: Vec<PathBuf>, registered: &[PathBuf], keep_clear: &[PathBuf]) -> Vec<PathBuf> {
    let all: Vec<PathBuf> = roots.iter().chain(registered).cloned().collect();
    let fences = root_fences(&all, keep_clear);
    roots
        .into_iter()
        .filter(|r| !r.components().any(|c| matches!(c, std::path::Component::ParentDir)) && !through_planted_link(r, &fences))
        .collect()
}

/// Where a planted link would sit: inside any of `roots`, as spelled or
/// resolved (a resolution that covers a `keep_clear` folder is no fence: it
/// would count every system link as planted).
fn root_fences(roots: &[PathBuf], keep_clear: &[PathBuf]) -> Vec<PathBuf> {
    let resolve = |r: &Path| canonical_or_new(r).unwrap_or_else(|_| r.to_path_buf());
    let keep_clear: Vec<PathBuf> = keep_clear.iter().filter(|k| k.is_absolute()).map(|k| resolve(k)).collect();
    let covers_kept = |c: &Path| keep_clear.iter().any(|k| k.starts_with(c));
    let mut fences: Vec<PathBuf> = Vec::new();
    for root in roots {
        fences.push(root.clone());
        let canonical = resolve(root);
        if !covers_kept(&canonical) {
            fences.push(canonical);
        }
    }
    fences
}

/// Every registered project folder, mirror override and box folder (absolute
/// ones only: a relative entry would resolve against the process's cwd).
pub(crate) fn registered_roots(projects: &ProjectsList, boxes: &BoxesList) -> Vec<PathBuf> {
    let mut registered: Vec<PathBuf> = projects.iter().filter_map(project_dir).collect();
    registered.extend(projects.iter().filter_map(mirror_override_dir));
    registered.extend(boxes.iter().filter_map(|b| b.folder.as_deref()).map(str::trim).filter(|f| !f.is_empty()).map(PathBuf::from));
    registered.retain(|r| r.is_absolute());
    registered
}

/// Whether `root` (a project's folder, as the phone's file browser is handed
/// it) is reached through a link planted inside any registered project, mirror
/// or box folder: such a root is refused, never followed.
pub(crate) fn is_planted_root(root: &Path) -> bool {
    let projects = PROJECTS.get("projects.json");
    let boxes = BOXES.get("boxes.json");
    is_planted_root_in(root, &projects, &boxes, &keep_clear_roots())
}

fn is_planted_root_in(root: &Path, projects: &ProjectsList, boxes: &BoxesList, keep_clear: &[PathBuf]) -> bool {
    through_planted_link(root, &root_fences(&registered_roots(projects, boxes), keep_clear))
}

/// The folders [`drop_planted_roots`] keeps clear of the fences: home and the
/// state dir.
pub(crate) fn keep_clear_roots() -> Vec<PathBuf> {
    vec![crate::paths::home_dir(), storage::state_dir()]
}

/// [`drop_planted_roots`] against `projects`/`boxes`, then each survivor
/// canonicalized where it can be (the literal path stays for a folder that
/// does not exist yet).
fn pin_roots(roots: Vec<PathBuf>, projects: &ProjectsList, boxes: &BoxesList) -> Vec<PathBuf> {
    let mut roots = drop_planted_roots(roots, &registered_roots(projects, boxes), &keep_clear_roots());
    roots.iter_mut().for_each(|r| *r = r.canonicalize().unwrap_or_else(|_| r.clone()));
    roots
}

/// Whether a symlink on `root`'s spelling (`root` itself or an ancestor) sits
/// strictly inside one of `fences`, by its spelled or its resolved location.
fn through_planted_link(root: &Path, fences: &[PathBuf]) -> bool {
    root.ancestors().any(|at| {
        if !fs::symlink_metadata(at).is_ok_and(|m| m.file_type().is_symlink()) {
            return false;
        }
        let real = at.parent().zip(at.file_name()).and_then(|(parent, name)| parent.canonicalize().ok().map(|p| p.join(name)));
        let inside = |loc: &Path| fences.iter().any(|f| loc != f.as_path() && loc.starts_with(f));
        inside(at) || real.as_deref().is_some_and(inside)
    })
}

/// Whether `local_file` is a known project's `project.json` (`local_file` in
/// `projects.json`), by its spelling or, failing that, by where it resolves.
pub(crate) fn is_project_local_file(local_file: &str) -> bool {
    is_local_file_in(&PROJECTS.get("projects.json"), local_file)
}

fn is_local_file_in(projects: &ProjectsList, local_file: &str) -> bool {
    if local_file.trim().is_empty() {
        return false;
    }
    if projects.iter().any(|e| !e.local_file.is_empty() && e.local_file == local_file) {
        return true;
    }
    let Ok(wanted) = fs::canonicalize(local_file) else {
        return false;
    };
    projects
        .iter()
        .filter(|e| !e.local_file.is_empty())
        .any(|e| fs::canonicalize(&e.local_file).is_ok_and(|known| known == wanted))
}

/// The last parse of one state file, reused while the file's bytes are unchanged.
///
/// Every confinement check (each `file_mtime` poll of every open viewer) used to
/// parse all of `projects.json` — thousands of `serde_json::Value`s for the
/// entries' flattened `extra` — making it the process's busiest allocator.
/// Keyed on the bytes, not on mtime/len: the file is rewritten in place by many
/// writers, and a project switch swaps two statuses without changing its length.
struct StateJsonCache<T>(std::sync::Mutex<Option<(PathBuf, String, std::sync::Arc<T>)>>);

impl<T> StateJsonCache<T>
where
    T: serde::de::DeserializeOwned + Default,
{
    const fn new() -> Self {
        Self(std::sync::Mutex::new(None))
    }

    /// The state file `name`, parsed; `T::default()` when it is absent or
    /// unparseable, so confinement degrades to fail-closed. Failures are not cached.
    fn get(&self, name: &str) -> std::sync::Arc<T> {
        self.load(storage::state_dir().join(name))
    }

    fn load(&self, path: PathBuf) -> std::sync::Arc<T> {
        let Ok(content) = fs::read_to_string(&path) else {
            return std::sync::Arc::new(T::default());
        };
        let mut slot = self.0.lock_ok();
        if let Some((cached_path, cached, value)) = slot.as_ref() {
            if *cached_path == path && *cached == content {
                return value.clone();
            }
        }
        let Ok(parsed) = serde_json::from_str::<T>(&content) else {
            *slot = None;
            return std::sync::Arc::new(T::default());
        };
        let value = std::sync::Arc::new(parsed);
        *slot = Some((path, content, value.clone()));
        value
    }
}

/// Pure core of [`allowed_roots`], split out so the project/box scoping logic is
/// testable without touching the real state dir.
fn compute_allowed_roots(
    projects: &ProjectsList,
    boxes: &BoxesList,
    scope_id: Option<&str>,
    root_work: &Path,
) -> Vec<PathBuf> {
    // The ROOT scope — a viewer with no owning project (`scope_id: None`), i.e.
    // the side panel's root view and any root-scope tab — browses the root
    // terminal folder `~/tabtivity/root`. Its *listing* passes confinement because
    // `list_dir` confines against the project_dir argument, but every absolute-
    // path read a viewer then makes (`read_file_bytes`, `file_mtime`, …) lands
    // here — and a roots set without that folder refused each one, so a PDF
    // opened from the root tree sat on "Loading" forever. Only the no-project
    // scope gains it: a project-scoped viewer stays project-isolated.
    let mut roots: Vec<PathBuf> = Vec::new();
    // A BOX scope (`box:<id>`) has no single anchor project: its roots are the
    // box folder plus every member's tree (and mirror override) — the
    // co-accessible set the box exists to create. An unknown box stays empty
    // (fail closed), and the root work dir is never folded in: a box viewer is
    // not the root scope.
    if let Some(box_id) = scope_id.and_then(crate::commands::boxes::box_id_of_scope) {
        let Some(b) = boxes.iter().find(|b| b.id == box_id) else {
            return Vec::new();
        };
        if let Some(folder) = &b.folder {
            roots.push(PathBuf::from(folder));
        }
        let in_box = || {
            projects
                .iter()
                .filter(|e| b.member_ids.iter().any(|m| m == &e.id))
        };
        roots.extend(in_box().filter_map(project_dir));
        roots.extend(in_box().filter_map(mirror_override_dir));
        return pin_roots(roots, projects, boxes);
    }
    if scope_id.is_none() {
        roots.push(root_work.to_path_buf());
    }
    // Anchor on the scope project when one is named, else the current project.
    let anchor = match scope_id {
        Some(id) => projects.iter().find(|e| e.id == id),
        None => projects.iter().find(|e| e.status == "current"),
    };
    let Some(anchor) = anchor else {
        // No current project: the root scope still reads its own folder.
        return pin_roots(roots, projects, boxes);
    };

    // Start with the anchor project, then fold in every member of any box the
    // anchor belongs to (`member_ids` is the authoritative membership —
    // see schema::boxes::ProjectBox).
    let mut ids: HashSet<&str> = HashSet::new();
    ids.insert(anchor.id.as_str());
    for b in boxes {
        if b.member_ids.iter().any(|m| m == &anchor.id) {
            for m in &b.member_ids {
                ids.insert(m.as_str());
            }
        }
    }

    let in_scope = || projects.iter().filter(|e| ids.contains(e.id.as_str()));
    roots.extend(in_scope().filter_map(project_dir));
    // For a remote (SSH) project the tree the user actually browses is the local
    // *mirror*, not the state dir that `project_dir` returns. The default mirror
    // lives under the state dir (already covered above), but an explicit
    // `extra["mirror"]` relocation — including the top-level default minted at
    // import — sits outside it, so add each in-scope project's mirror override as
    // its own root. Otherwise opening a mirrored local file fails confinement
    // with a spurious "not in the current project" error. Pure: read straight
    // from the entry, no state-dir touch.
    roots.extend(in_scope().filter_map(mirror_override_dir));
    // Canonicalize where possible so symlinked roots compare correctly; fall
    // back to the literal path when the dir does not exist (yet). A root
    // reached through a link planted inside another root is dropped first.
    pin_roots(roots, projects, boxes)
}

/// A project entry's working directory: the canonical `directory` field when
/// present, otherwise the parent of its `local_file` (which is `<dir>/project.json`).
fn project_dir(entry: &ProjectEntry) -> Option<PathBuf> {
    entry.directory().map(PathBuf::from)
}

/// A remote project's explicit local-mirror override (`extra["mirror"]`), or
/// `None` when unset/empty or for a local project. Mirrors the resolution in
/// `services::remote_sync::mirror_override` but stays pure (reads the passed
/// entry, not the state dir) so `compute_allowed_roots` remains testable.
fn mirror_override_dir(entry: &ProjectEntry) -> Option<PathBuf> {
    let raw = entry.extra.get("mirror").and_then(Value::as_str)?.trim();
    (!raw.is_empty()).then(|| PathBuf::from(raw))
}

/// Resolve `p` to a canonical path for confinement checks, or `None` when it
/// is refused outright. Something standing at `p` (a file, a folder, a link)
/// counts by its real target, so a dangling link — which resolves nowhere —
/// is refused rather than taken for a new file (threat recheck gap 22). For a
/// path that does not exist yet the nearest existing ancestor is resolved and
/// the rest re-joined, so a write target inside an allowed root still
/// validates before creation and a missing folder below an in-root link out
/// of the project is judged by where the link leads. A `..` component is
/// refused: `root/missing/../..` used to pass the prefix check lexically.
fn resolve_for_confinement(p: &Path) -> Option<PathBuf> {
    if p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return None;
    }
    if fs::symlink_metadata(p).is_ok() {
        return p.canonicalize().ok();
    }
    canonical_or_new(p).ok()
}

fn confine_abs(p: &Path, scope_id: Option<&str>) -> Result<(), String> {
    confine_abs_within(p, &allowed_roots(scope_id))
}

/// Pure confinement check against an explicit root set. Empty `roots` (no current
/// project) refuses everything.
fn confine_abs_within(p: &Path, roots: &[PathBuf]) -> Result<(), String> {
    match resolve_for_confinement(p) {
        Some(resolved) if roots.iter().any(|root| resolved.starts_with(root)) => Ok(()),
        _ => Err(outside_roots(p)),
    }
}

/// The refusal for a path outside every allowed root.
fn outside_roots(p: &Path) -> String {
    format!(
        "path '{}' is not in the current project (open that project, or add it to a box with the current one, to access it)",
        p.display()
    )
}

// ── Handle-based viewer I/O (threat recheck gaps 22 and 31, decision D1) ───

/// What [`open_confined`] opens a path for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Confined {
    /// An existing regular file, for reading.
    Read,
    /// An existing regular file or folder, for its metadata only.
    Stat,
    /// An existing regular file, emptied for an in-place save.
    Overwrite,
    /// An existing regular file emptied for an in-place save, or a new one
    /// created `O_EXCL`.
    Write,
    /// [`Confined::Write`], and the file's own folder is walked by name from
    /// its canonical parent, so a folder that is a link is refused too: the
    /// deck's TeX figures, whose folder an agent could otherwise point at a
    /// box sibling (threat recheck gap 23, D3). A leaf with `~` (a Windows
    /// 8.3 alias such as `EVIL~1.PNG`, which names another file) is refused.
    WriteOwnFolder,
}

/// `write_file_bytes` request header: `1` asks for
/// [`Confined::WriteOwnFolder`] (the deck's figure writes).
pub const NO_FOLDER_LINK_HEADER: &str = "x-no-folder-link";

/// Open the absolute path `p` inside one of `roots` without following a link
/// that was not there when the path was checked — the viewers' one way to the
/// local disk (`read_file_*_local`, `write_file_*_local`, `file_mtime_local`,
/// `file_size_local`).
///
/// The longest root holding the path is opened, and every folder below it is
/// walked one name at a time through held handles
/// (`mobile_control::files::ProjectDir`: `openat(O_NOFOLLOW)` on Unix,
/// `NtCreateFile` with `FILE_OPEN_REPARSE_POINT` on Windows). Every component
/// of a canonical path is link-free, so a folder swapped for a link after the
/// check fails the walk instead of redirecting it.
///
/// Reads canonicalize the whole path: an in-root link still reads, as it
/// always did, and its real target is what gets opened. A save canonicalizes
/// only the folder and opens the leaf itself without following it: **a leaf
/// that is a link — dangling or not, into the project or out of it — or a
/// Windows link-type (name-surrogate) reparse point is refused** (decision
/// D1). Other Windows reparse points (OneDrive placeholders, dedup) are no
/// links and are read and saved through their filter. An existing file is
/// emptied in place (inode, owner and mode kept); a missing one is created
/// `O_EXCL`. A `..` or `.` component is refused outright.
fn open_confined(p: &Path, roots: &[PathBuf], mode: Confined) -> Result<fs::File, String> {
    use crate::services::mobile_control::files::{ProjectDir, WriteRefusal};
    use std::path::Component;
    if !p.is_absolute() || p.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir)) {
        return Err(format!("path '{}' is not a plain absolute path", p.display()));
    }
    let missing = || format!("{}: No such file or directory", p.display());
    let not_a_file = || "not a file".to_string();
    let saving = matches!(mode, Confined::Overwrite | Confined::Write | Confined::WriteOwnFolder);
    // The real path to walk: the canonical folder plus the leaf as named for
    // a save (the canonical grandparent plus folder and leaf as named for
    // `WriteOwnFolder`), the canonical whole path for a read.
    let target = if saving {
        let leaf = match p.components().next_back() {
            Some(Component::Normal(leaf)) => leaf,
            _ => return Err(not_a_file()),
        };
        let parent = p.parent().ok_or_else(not_a_file)?;
        if mode == Confined::WriteOwnFolder {
            if leaf.to_string_lossy().contains('~') {
                return Err(format!("'{}' has a `~` in its name; it was not saved", p.display()));
            }
            let folder = match parent.components().next_back() {
                Some(Component::Normal(folder)) => folder,
                _ => return Err(not_a_file()),
            };
            let grand = parent.parent().ok_or_else(not_a_file)?;
            grand.canonicalize().map_err(|_| missing())?.join(folder).join(leaf)
        } else {
            parent.canonicalize().map_err(|_| missing())?.join(leaf)
        }
    } else {
        p.canonicalize().map_err(|_| missing())?
    };
    let root = roots
        .iter()
        .filter(|root| target.starts_with(root))
        .max_by_key(|root| root.components().count())
        .ok_or_else(|| outside_roots(p))?;
    let rel = target.strip_prefix(root).map_err(|_| outside_roots(p))?;
    let mut names = Vec::new();
    for component in rel.components() {
        match component {
            Component::Normal(name) => names.push(
                name.to_str()
                    .ok_or_else(|| format!("path '{}' is not valid UTF-8", p.display()))?,
            ),
            _ => return Err(format!("path '{}' is not a plain absolute path", p.display())),
        }
    }
    let changed = || {
        format!(
            "'{}' changed while it was opened (a folder on the way is now a link or gone); nothing was read or written",
            p.display()
        )
    };
    let mut dir = ProjectDir::open_root(root).map_err(|_| missing())?;
    let Some((leaf, folders)) = names.split_last() else {
        // The root itself: a folder, so only its metadata is served.
        return if mode == Confined::Stat { Ok(dir.into_file()) } else { Err(not_a_file()) };
    };
    let link = || format!("'{}' is a link; viewers do not save through links", p.display());
    for (i, name) in folders.iter().enumerate() {
        let own_folder = mode == Confined::WriteOwnFolder && i + 1 == folders.len();
        // The deck makes its figure folder on the first figure (`mkdirat`,
        // then opened no-follow like any other folder).
        if own_folder && matches!(dir.lookup_dir(name), Ok(None)) {
            dir.create_dir(name).map_err(|e| e.to_string())?;
        }
        dir = match dir.lookup_dir(name) {
            Ok(Some(next)) => next,
            Ok(None) => return Err(missing()),
            // The own folder of a `WriteOwnFolder` save was never resolved:
            // something other than a plain folder there is that folder.
            Err(()) if own_folder => {
                return Err(format!(
                    "'{}' is in a folder that is a link; viewers do not save through links",
                    p.display()
                ))
            }
            Err(()) => return Err(changed()),
        };
    }
    let refused = |refusal: WriteRefusal| match refusal {
        WriteRefusal::Link => link(),
        WriteRefusal::NotFile => not_a_file(),
        WriteRefusal::Io(error) => error.to_string(),
    };
    match mode {
        Confined::Read => match dir.lookup_file(leaf) {
            Ok(Some((file, _))) => Ok(file),
            Ok(None) => Err(missing()),
            Err(()) => Err(not_a_file()),
        },
        Confined::Stat => match dir.lookup_file(leaf) {
            Ok(Some((file, _))) => Ok(file),
            Ok(None) => Err(missing()),
            Err(()) => match dir.lookup_dir(leaf) {
                Ok(Some(folder)) => Ok(folder.into_file()),
                Ok(None) => Err(missing()),
                Err(()) => Err(not_a_file()),
            },
        },
        Confined::Overwrite => dir.open_existing_for_write(leaf).map_err(refused)?.ok_or_else(missing),
        Confined::Write | Confined::WriteOwnFolder => {
            if let Some(file) = dir.open_existing_for_write(leaf).map_err(refused)? {
                return Ok(file);
            }
            match dir.create_file(leaf) {
                Ok(file) => Ok(file),
                // Something took the name since: only an existing regular
                // file is written, a link that appeared is still refused.
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    dir.open_existing_for_write(leaf).map_err(refused)?.ok_or_else(missing)
                }
                Err(error) => Err(error.to_string()),
            }
        }
    }
}

/// At most `max` bytes of a file [`open_confined`] proved regular, read from
/// its handle; a file larger than that is refused, never cut short.
fn read_opened(file: fs::File, max: u64) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    if len > max {
        return Err(format!("file too large to view ({len} bytes; limit {max})"));
    }
    let mut bytes = Vec::with_capacity(len as usize);
    file.take(max + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > max {
        return Err(format!("file too large to view (over {max} bytes; limit {max})"));
    }
    Ok(bytes)
}

/// Write `content` through a handle [`open_confined`] opened for a save.
fn write_opened(mut file: fs::File, content: &[u8]) -> Result<(), String> {
    use std::io::Write;
    file.write_all(content).map_err(|e| e.to_string())
}

/// Confine a path a **non-file** command is about to act on (today:
/// `commands::apps::run_script_detached`, which runs `bash <path>`) to exactly the
/// per-project roots every file command is bound by.
///
/// Exposed because the confinement logic in this module — canonicalize-then-prefix,
/// fail-closed on an unknown scope — is the only correct implementation in the
/// codebase, and a second copy elsewhere would drift from it.
pub(crate) fn confine_project_path(p: &Path, scope_id: Option<&str>) -> Result<(), String> {
    confine_abs(p, scope_id)
}

/// Confine a path a server **user** (not the box's admin) names to a command
/// with no confinement of its own — `list_dir_all` (on the desktop it stands
/// in for an OS file dialog), every path argument `core_dispatch`'s user table
/// holds, the browser's file tickets and grants
/// (`services::core_dispatch::user_path`) — to [`user_roots`]. A relative path
/// is refused: it would resolve against the server process's cwd.
pub(crate) fn confine_user_path(p: &Path) -> Result<(), String> {
    if !p.is_absolute() {
        return Err(format!("path '{}' is not absolute", p.display()));
    }
    confine_abs_within(p, &user_roots()).map_err(|_| outside_user_roots(p))
}

/// The refusal for a path outside every one of a user's roots. Keeps the
/// "not in the current project" wording the other refusals use.
fn outside_user_roots(p: &Path) -> String {
    format!(
        "path '{}' is not in the current project or any other of your projects",
        p.display()
    )
}

// ── Helpers ───────────────────────────────────────────────────────────────

fn canonical(path: &str) -> Result<PathBuf, String> {
    fs::canonicalize(path).map_err(|e| format!("canonicalize {path}: {e}"))
}

fn collect_project_endings(
    root: &Path,
    dir: &Path,
    depth: usize,
    endings: &mut BTreeSet<String>,
) -> Result<(), String> {
    enforce_confinement(root, dir)?;
    if depth >= MAX_SCAN_DEPTH {
        return Ok(());
    }
    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        // Use the dir entry's own file type so symlinks are never followed —
        // a self-referential symlink (e.g. `repo -> .`) would otherwise recurse
        // until the path length limit. `Path::is_dir()` follows symlinks; this
        // does not.
        let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
        if is_dir {
            if should_skip_ending_scan_dir(&name) {
                continue;
            }
            collect_project_endings(root, &path, depth + 1, endings)?;
        } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            endings.insert(format!(".{ext}"));
        }
    }
    Ok(())
}

fn normalize_project_rel_path(rel: &str) -> Result<String, String> {
    let p = std::path::Path::new(rel);
    for component in p.components() {
        match component {
            std::path::Component::ParentDir | std::path::Component::RootDir => {
                return Err(format!("invalid path component in '{rel}'"));
            }
            _ => {}
        }
    }
    Ok(rel.trim_start_matches('/').to_string())
}

fn gitignore_ignore_rules(rel_path: &str, is_dir: bool) -> Vec<String> {
    let rule = if is_dir {
        format!("/{rel_path}/")
    } else {
        format!("/{rel_path}")
    };
    vec![rule]
}

fn gitignore_unignore_rules(rel_path: &str, is_dir: bool) -> Vec<String> {
    let mut rules = Vec::new();
    let parts: Vec<&str> = rel_path
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    let parent_count = if is_dir {
        parts.len()
    } else {
        parts.len().saturating_sub(1)
    };
    for i in 0..parent_count {
        rules.push(format!("!/{}/", parts[..=i].join("/")));
    }
    if !is_dir {
        rules.push(format!("!/{rel_path}"));
    }
    rules
}

fn collect_project_paths(
    root: &Path,
    dir: &Path,
    rel_dir: &str,
    depth: usize,
    paths: &mut Vec<ProjectPathEntry>,
) -> Result<(), String> {
    enforce_confinement(root, dir)?;
    if depth >= MAX_SCAN_DEPTH {
        return Ok(());
    }
    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if crate::brand::is_project_dir(&name) {
            continue;
        }
        let rel_path = if rel_dir.is_empty() {
            name.clone()
        } else {
            format!("{rel_dir}/{name}")
        };
        // `entry.file_type()` does not follow symlinks; a symlinked directory is
        // reported as a non-directory so we never recurse through it (and so a
        // self-referential symlink can't loop). See collect_project_endings.
        let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
        paths.push(ProjectPathEntry {
            path: rel_path.clone(),
            is_dir,
        });
        if is_dir && !should_skip_ending_scan_dir(&name) {
            collect_project_paths(root, &path, &rel_path, depth + 1, paths)?;
        }
    }
    Ok(())
}

/// Hard cap on recursive project-tree scan depth. Guards against pathological
/// trees (deep nesting, symlink chains) wedging a scan even though symlinks are
/// no longer followed.
const MAX_SCAN_DEPTH: usize = 64;

fn should_skip_ending_scan_dir(name: &str) -> bool {
    crate::brand::is_project_dir(name) || matches!(
        name,
        ".git"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | ".next"
            | ".cache"
            // Python vendor/artifact dirs — a 50k-file venv would otherwise be
            // walked on every Ctrl+P/QuickOpen scan.
            | ".venv"
            | "venv"
            | "__pycache__"
            | ".tox"
    )
}

/// Write `content` to `target_c`, a path `canonical_or_new` resolved and
/// `enforce_confinement` passed, creating its missing folders. The file itself
/// is opened `O_NOFOLLOW`: a link swapped in after the check is refused rather
/// than followed out of the project.
fn write_confined(target_c: &Path, content: &[u8]) -> Result<(), String> {
    use std::io::Write;
    if let Some(parent) = target_c.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    options
        .open(target_c)
        .and_then(|mut f| f.write_all(content))
        .map_err(|e| e.to_string())
}

/// One subdirectory in a [`DirListing`]: its display name and absolute path.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
}

/// The directory listing backing the in-app folder-browser popup: the current
/// absolute directory, its parent (for up-navigation; `None` at a filesystem
/// root), and the immediate subdirectories.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<DirEntry>,
}

/// List the immediate subdirectories of a LOCAL directory for the in-app folder
/// picker. Unlike [`list_dir`], this is deliberately NOT project-confined — the
/// picker browses the whole local filesystem to choose a destination folder.
/// Empty `path` starts at the user's home directory. Files are omitted (only
/// folders); unreadable entries are skipped rather than failing the whole call.
/// The folder half of [`list_dir_all`], read by the same body.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn list_dirs(path: String) -> Result<DirListing, String> {
    app_core::rt::try_blocking("fs", move || list_local_dir(&path, true)).await.map(|listing| DirListing {
        path: listing.path,
        parent: listing.parent,
        entries: listing.dirs,
    })
}

/// One file in a [`FileListing`].
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRow {
    pub name: String,
    pub path: String,
    pub size: u64,
}

/// A LOCAL directory's folders and files, for the browser client's
/// server-side file picker (hosted plan §3.5): the desktop's OS dialog has
/// no counterpart in a browser, and a browser `<input type=file>` would pick
/// from the wrong machine. Same reach as [`list_dirs`] — the whole local
/// filesystem the daemon's user can read, deliberately not project-confined,
/// because what it replaces (the OS picker) was not either.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileListing {
    pub path: String,
    pub parent: Option<String>,
    pub dirs: Vec<DirEntry>,
    pub files: Vec<FileRow>,
}

/// Folders and files of a local directory (see [`FileListing`]). Empty `path`
/// starts at the user's home; unreadable entries are skipped.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn list_dir_all(path: String) -> Result<FileListing, String> {
    app_core::rt::try_blocking("fs", move || list_local_dir(&path, false)).await
}

/// The one local directory read behind [`list_dirs`] and [`list_dir_all`]:
/// `..`/links resolved to a stable absolute path where possible (the raw path
/// otherwise), folders and — unless `dirs_only` — regular files, each sorted
/// by name. A link is neither: entry types are read without following it.
pub fn list_local_dir(path: &str, dirs_only: bool) -> Result<FileListing, String> {
    let trimmed = path.trim();
    let base = if trimmed.is_empty() {
        crate::paths::home_dir()
    } else {
        PathBuf::from(trimmed)
    };
    let base = fs::canonicalize(&base).unwrap_or(base);
    let read = fs::read_dir(&base).map_err(|e| format!("cannot read '{}': {e}", base.display()))?;
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    for entry in read.flatten() {
        let Ok(kind) = entry.file_type() else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        if kind.is_dir() {
            dirs.push(DirEntry { name, path: display_path(&entry.path()) });
        } else if kind.is_file() && !dirs_only {
            let Ok(meta) = entry.metadata() else { continue };
            files.push(FileRow { name, path: display_path(&entry.path()), size: meta.len() });
        }
    }
    dirs.sort_by_key(|d| d.name.to_lowercase());
    files.sort_by_key(|f| f.name.to_lowercase());
    Ok(FileListing {
        path: display_path(&base),
        parent: base.parent().map(display_path),
        dirs,
        files,
    })
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests;

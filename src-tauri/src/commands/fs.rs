//! Filesystem command handlers: the file-tree browser, gitignore editing, MIME
//! detection, and the absolute-path file readers/writers backing the in-app
//! viewers. Extracted from `commands::projects` (Structure #1) so the
//! path-confinement security work (Security #1/#3) and MIME-laziness work
//! (Efficiency #15) have a dedicated, testable home alongside `fs_watch`.

use std::collections::{BTreeSet, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::services::tree_copy::{copy_tree, CopyReport};
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

// `excluded_rel_set` lives in `crate::paths` (S5).
pub use crate::paths::excluded_rel_set;

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

// The confinement roots and the handle-based open live in
// `services::fs_confine` (S5); re-exported for the commands and their tests.
pub(crate) use crate::services::fs_confine::*;


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

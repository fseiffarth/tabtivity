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

use crate::schema::boxes::BoxesList;
use crate::schema::projects::{ProjectEntry, ProjectsList};
use crate::storage;

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
/// `pool` is Tauri-injected managed state; the frontend does not pass it.
#[tauri::command]
pub async fn list_dir(
    project_dir: String,
    rel_path: String,
    pool: tauri::State<'_, crate::services::remote::RemotePoolState>,
) -> Result<Vec<FileEntry>, String> {
    // Detect remote BEFORE any local-fs access (`canonical` would touch the fs).
    if let Some(target) = crate::services::remote::remote_target_for_dir(&project_dir) {
        return list_dir_remote(&target, &rel_path, pool.inner()).await;
    }
    list_dir_local(&project_dir, &rel_path)
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
#[tauri::command]
pub fn resolve_text_paths(bases: Vec<String>, candidates: Vec<String>) -> Vec<Option<FileEntry>> {
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
/// name, so the most recent download is first.
#[tauri::command]
pub fn list_recent_downloads(
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
#[tauri::command]
pub async fn dir_size(
    project_dir: String,
    rel_path: String,
    excluded: Option<Vec<String>>,
    pool: tauri::State<'_, crate::services::remote::RemotePoolState>,
) -> Result<u64, String> {
    let _ = &pool; // remote path uses SSH exec, not the SFTP pool; keep the arg for symmetry
    if let Some(target) = crate::services::remote::remote_target_for_dir(&project_dir) {
        let remote_dir = join_remote_dir(&target.spec.remote_path, &rel_path);
        let spec = target.spec.clone();
        return tokio::task::spawn_blocking(move || {
            crate::services::ssh_exec::remote_dir_size(&spec, &remote_dir)
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    let excluded = excluded.unwrap_or_default();
    tokio::task::spawn_blocking(move || dir_size_local(&project_dir, &rel_path, &excluded))
        .await
        .map_err(|e| e.to_string())?
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
#[tauri::command]
pub async fn dir_size_breakdown(
    project_dir: String,
    rel_path: String,
    excluded: Option<Vec<String>>,
) -> Result<DirSizeBreakdown, String> {
    let excluded = excluded.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        dir_size_breakdown_local(&project_dir, &rel_path, &excluded)
    })
    .await
    .map_err(|e| e.to_string())?
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

/// Offload a blocking local-fs body to a worker thread. The full recursive
/// walks (Ctrl+P/QuickOpen), tree copies/moves, external imports, and archive
/// extraction below all do work proportional to tree/archive size; run inline
/// they blocked the main thread — the freeze class `commands::git`'s
/// `run_off_thread` doc describes. The sync bodies stay directly
/// unit-testable.
async fn run_off_thread<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("fs task failed: {e}"))?
}

#[tauri::command]
pub async fn list_project_endings(project_dir: String) -> Result<Vec<String>, String> {
    run_off_thread(move || list_project_endings_blocking(project_dir)).await
}

pub fn list_project_endings_blocking(project_dir: String) -> Result<Vec<String>, String> {
    let root = canonical(&project_dir)?;
    let mut endings = BTreeSet::new();
    collect_project_endings(&root, &root, 0, &mut endings)?;
    Ok(endings.into_iter().collect())
}

#[tauri::command]
pub async fn list_project_paths(project_dir: String) -> Result<Vec<ProjectPathEntry>, String> {
    run_off_thread(move || list_project_paths_blocking(project_dir)).await
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
#[tauri::command]
pub async fn rename_path(
    project_dir: String,
    old_rel: String,
    new_name: String,
    pool: tauri::State<'_, RemotePoolState>,
) -> Result<(), String> {
    let name = validate_bare_name(&new_name)?;
    if let Some(target) = crate::services::remote::remote_target_for_dir(&project_dir) {
        let from = remote_join_confined(&target.spec.remote_path, &old_rel)?;
        // Rename in place: keep `from`'s directory, swap the final component.
        let to = match from.rfind('/') {
            Some(i) => format!("{}/{}", &from[..i], name),
            None => name.clone(),
        };
        return remote_rename(pool.inner(), &target, &from, &to).await;
    }
    rename_path_local(&project_dir, &old_rel, &new_name)
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
#[tauri::command]
pub async fn delete_file(
    project_dir: String,
    rel_path: String,
    pool: tauri::State<'_, RemotePoolState>,
) -> Result<(), String> {
    if let Some(target) = crate::services::remote::remote_target_for_dir(&project_dir) {
        let full = remote_join_confined(&target.spec.remote_path, &rel_path)?;
        return remote_remove_file(pool.inner(), &target, &full).await;
    }
    delete_file_local(&project_dir, &rel_path)
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
#[tauri::command]
pub async fn delete_dir(
    project_dir: String,
    rel_path: String,
    pool: tauri::State<'_, RemotePoolState>,
) -> Result<(), String> {
    if let Some(target) = crate::services::remote::remote_target_for_dir(&project_dir) {
        let clean = normalize_project_rel_path(&rel_path)?;
        if clean.is_empty() {
            return Err("refusing to delete project root".to_string());
        }
        let full = join_remote_dir(&target.spec.remote_path, &clean);
        return remote_remove_dir(pool.inner(), &target, &full).await;
    }
    delete_dir_local(&project_dir, &rel_path)
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
#[tauri::command]
pub async fn create_file(
    project_dir: String,
    rel_path: String,
    pool: tauri::State<'_, RemotePoolState>,
) -> Result<(), String> {
    if let Some(target) = crate::services::remote::remote_target_for_dir(&project_dir) {
        let full = remote_join_confined(&target.spec.remote_path, &rel_path)?;
        return remote_create_file(pool.inner(), &target, &full).await;
    }
    create_file_local(&project_dir, &rel_path)
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
#[tauri::command]
pub async fn write_project_file(
    project_dir: String,
    rel_path: String,
    content: String,
    pool: tauri::State<'_, RemotePoolState>,
) -> Result<(), String> {
    if let Some(target) = crate::services::remote::remote_target_for_dir(&project_dir) {
        let full = remote_join_confined(&target.spec.remote_path, &rel_path)?;
        return remote_write(pool.inner(), &target, &full, content.as_bytes()).await;
    }
    write_project_file_local(&project_dir, &rel_path, &content)
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
#[tauri::command]
pub async fn write_project_file_bytes(
    project_dir: String,
    rel_path: String,
    content: Vec<u8>,
    pool: tauri::State<'_, RemotePoolState>,
) -> Result<(), String> {
    if let Some(target) = crate::services::remote::remote_target_for_dir(&project_dir) {
        let full = remote_join_confined(&target.spec.remote_path, &rel_path)?;
        return remote_write(pool.inner(), &target, &full, &content).await;
    }
    write_project_file_bytes_local(&project_dir, &rel_path, &content)
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

#[tauri::command]
pub fn update_gitignore_rule(
    project_dir: String,
    rel_path: String,
    is_dir: bool,
    action: String,
) -> Result<(), String> {
    let root = canonical(&project_dir)?;
    let clean_rel = normalize_project_rel_path(&rel_path)?;
    let target_c = canonical_or_new(&root.join(&clean_rel))?;
    enforce_confinement(&root, &target_c)?;

    let gitignore_path = root.join(".gitignore");
    let existing = fs::read_to_string(&gitignore_path).unwrap_or_default();
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
    fs::write(&gitignore_path, next).map_err(|e| e.to_string())
}

/// Create a new directory inside the project.
#[tauri::command]
pub async fn create_dir(
    project_dir: String,
    rel_path: String,
    pool: tauri::State<'_, RemotePoolState>,
) -> Result<(), String> {
    if let Some(target) = crate::services::remote::remote_target_for_dir(&project_dir) {
        let full = remote_join_confined(&target.spec.remote_path, &rel_path)?;
        return remote_mkdir(pool.inner(), &target, &full).await;
    }
    create_dir_local(&project_dir, &rel_path)
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
#[tauri::command]
pub async fn copy_path(
    src_project_dir: String,
    src_rel: String,
    dest_project_dir: String,
    dest_rel: String,
) -> Result<(), String> {
    run_off_thread(move || copy_path_blocking(src_project_dir, src_rel, dest_project_dir, dest_rel))
        .await
}

pub fn copy_path_blocking(
    src_project_dir: String,
    src_rel: String,
    dest_project_dir: String,
    dest_rel: String,
) -> Result<(), String> {
    let (src, dest) = resolve_transfer(&src_project_dir, &src_rel, &dest_project_dir, &dest_rel)?;
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    copy_recursive(&src, &dest).map_err(|e| e.to_string())
}

/// Move (cut/paste) a file or directory tree into another location. Same
/// confinement and pre-conditions as [`copy_path`]. Falls back to copy+remove
/// only when the rename failed because source and destination are on different
/// filesystems/volumes; any other rename error is returned as it is.
#[tauri::command]
pub async fn move_path(
    src_project_dir: String,
    src_rel: String,
    dest_project_dir: String,
    dest_rel: String,
) -> Result<(), String> {
    run_off_thread(move || move_path_blocking(src_project_dir, src_rel, dest_project_dir, dest_rel))
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
    copy_recursive(&src, &dest).map_err(|e| e.to_string())?;
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
#[tauri::command]
pub async fn import_external_file(
    project_dir: String,
    source_path: String,
    dest_rel: String,
    replace: bool,
    dest_name: Option<String>,
) -> Result<String, String> {
    run_off_thread(move || {
        import_external_file_blocking(project_dir, source_path, dest_rel, replace, dest_name)
    })
    .await
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
    copy_recursive(&src, &dest).map_err(|e| e.to_string())?;

    Ok(dest
        .strip_prefix(&root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or(file_name))
}

/// Whether a project-relative path currently exists. The drag-drop importer
/// calls this before copying so it can prompt rename-vs-replace on a collision.
#[tauri::command]
pub fn project_path_exists(project_dir: String, rel_path: String) -> Result<bool, String> {
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
#[tauri::command]
pub async fn extract_archive(project_dir: String, rel_path: String) -> Result<String, String> {
    run_off_thread(move || extract_archive_blocking(project_dir, rel_path)).await
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

/// Recursively copy `src` to `dest`. Directories are recreated and their
/// contents copied entry by entry; symlinks are not followed (copied as their
/// target's contents via the recursive descent on the resolved metadata).
fn copy_recursive(src: &Path, dest: &Path) -> std::io::Result<()> {
    if src.is_dir() {
        fs::create_dir_all(dest)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &dest.join(entry.file_name()))?;
        }
    } else {
        fs::copy(src, dest)?;
    }
    Ok(())
}

// ── MIME detection (magic bytes) ──────────────────────────────────────────

/// Detect a file's MIME type. Local projects sniff magic bytes (then fall back to
/// the extension); remote projects (mount-free, Phase 3) use the **extension**
/// only — avoiding a network fetch just to classify — after confining the path to
/// the remote project root.
#[tauri::command]
pub async fn detect_mime(
    path: String,
    project_id: Option<String>,
    _pool: tauri::State<'_, RemotePoolState>,
) -> Result<String, String> {
    if let Some(pid) = project_id.as_deref() {
        if let Some(target) = crate::services::remote::remote_target_for(pid) {
            // SSH-sync G2: a mirror-local path is classified on the LOCAL fs
            // (magic bytes); a host path uses the extension only (no fetch).
            if !crate::services::remote_sync::is_under_mirror(pid, &path) {
                confine_remote_abs(&target.spec.remote_path, &path)?;
                return Ok(ext_mime_or_octet(&path));
            }
        }
    }
    detect_mime_local(&path, project_id.as_deref())
}

/// Extension-based MIME for `path`, defaulting to `application/octet-stream`.
fn ext_mime_or_octet(path: &str) -> String {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(mime_for_ext)
        .unwrap_or_else(|| "application/octet-stream".to_string())
}

/// Local-fs MIME detection — byte-identical pre-Phase-3 body.
pub fn detect_mime_local(path: &str, scope_id: Option<&str>) -> Result<String, String> {
    let p = PathBuf::from(path);
    confine_abs_read(&p, scope_id)?;
    // 1. Try magic bytes via infer.
    if let Ok(mut f) = fs::File::open(&p) {
        let mut buf = [0u8; 8192];
        use std::io::Read;
        if let Ok(n) = f.read(&mut buf) {
            if let Some(kind) = infer::get(&buf[..n]) {
                return Ok(kind.mime_type().to_string());
            }
        }
    }
    // 2. Fall back to extension.
    Ok(ext_mime_or_octet(path))
}

// ── Viewer source classification (remote-native vs local mirror) ──────────

/// Classify where an in-app viewer's bytes come from, for the viewer's source
/// notice. Returns exactly one of:
///   - `"remote"` — a remote (SSH) project path served straight from the host
///                  over SFTP (remote-native, no local copy).
///   - `"local"`  — a remote project path under the local **mirror**, read on the
///                  LOCAL fs (the paired working copy synced from the host).
///   - `"none"`   — a local project (or root scope): there is no remote/local
///                  distinction, so the frontend shows no badge.
/// This mirrors the *exact* routing `read_file_text`/`read_file_bytes` apply
/// (`remote_target_for` gates remoteness, `is_under_mirror` picks the side), so
/// the badge can never disagree with where the bytes were actually read from.
#[tauri::command]
pub fn file_source(path: String, project_id: Option<String>) -> String {
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
#[tauri::command]
pub async fn read_file_text(
    path: String,
    project_id: Option<String>,
    pool: tauri::State<'_, RemotePoolState>,
) -> Result<String, String> {
    if let Some(pid) = project_id.as_deref() {
        if let Some(target) = crate::services::remote::remote_target_for(pid) {
            // SSH-sync G2: a path under the local mirror is read on the LOCAL fs
            // even for a remote project, so the local source view / local-on-remote
            // tabs see mirrored bytes instead of round-tripping SFTP.
            if !crate::services::remote_sync::is_under_mirror(pid, &path) {
                confine_remote_abs(&target.spec.remote_path, &path)?;
                let (size, _) = remote_metadata(pool.inner(), &target, &path).await?;
                if size > MAX_TEXT_VIEW_BYTES {
                    return Err(format!(
                        "file too large to view ({size} bytes; limit {MAX_TEXT_VIEW_BYTES})"
                    ));
                }
                let bytes = remote_read(pool.inner(), &target, &path).await?;
                return String::from_utf8(bytes)
                    .map_err(|_| "file is not valid UTF-8 text".to_string());
            }
        }
    }
    read_file_text_local(&path, project_id.as_deref())
}

/// Local-fs text read — byte-identical pre-Phase-3 body.
pub fn read_file_text_local(path: &str, scope_id: Option<&str>) -> Result<String, String> {
    let p = PathBuf::from(path);
    confine_abs_read(&p, scope_id)?;
    let meta = fs::metadata(&p).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".to_string());
    }
    if meta.len() > MAX_TEXT_VIEW_BYTES {
        return Err(format!(
            "file too large to view ({} bytes; limit {})",
            meta.len(),
            MAX_TEXT_VIEW_BYTES
        ));
    }
    let bytes = fs::read(&p).map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|_| "file is not valid UTF-8 text".to_string())
}

/// Write UTF-8 text to an absolute file path from the in-app editor.
///
/// Counterpart to `read_file_text`: same absolute `FileEntry.path`, confined to
/// Tabtivity's known roots (Security #1 — without it any reachable IPC caller could
/// overwrite arbitrary user files), refuses to grow a file past
/// `MAX_TEXT_VIEW_BYTES`, and only writes to an existing regular file (the
/// editor edits files opened from the tree; it never creates new paths).
#[tauri::command]
pub async fn write_file_text(
    path: String,
    content: String,
    project_id: Option<String>,
    pool: tauri::State<'_, RemotePoolState>,
) -> Result<(), String> {
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
                return remote_write(pool.inner(), &target, &path, content.as_bytes()).await;
            }
        }
    }
    write_file_text_local(&path, &content, project_id.as_deref())
}

/// Local-fs text write (existing regular file only) — byte-identical pre-Phase-3 body.
pub fn write_file_text_local(
    path: &str,
    content: &str,
    scope_id: Option<&str>,
) -> Result<(), String> {
    let p = PathBuf::from(path);
    confine_abs_write(&p, scope_id)?;
    let meta = fs::metadata(&p).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".to_string());
    }
    if content.len() as u64 > MAX_TEXT_VIEW_BYTES {
        return Err(format!(
            "content too large to save ({} bytes; limit {})",
            content.len(),
            MAX_TEXT_VIEW_BYTES
        ));
    }
    fs::write(&p, content).map_err(|e| e.to_string())
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
/// `confine_abs_write` as before.
#[tauri::command]
pub async fn write_file_bytes(
    request: tauri::ipc::Request<'_>,
    pool: tauri::State<'_, RemotePoolState>,
) -> Result<(), String> {
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
    write_file_bytes_routed(path, content, project_id, pool).await
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
    pool: tauri::State<'_, RemotePoolState>,
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
                return remote_write(pool.inner(), &target, &path, content).await;
            }
        }
    }
    write_file_bytes_local(&path, content, project_id.as_deref())
}

/// Local-fs byte write (may create a new file) — byte-identical pre-Phase-3 body.
pub fn write_file_bytes_local(
    path: &str,
    content: &[u8],
    scope_id: Option<&str>,
) -> Result<(), String> {
    let p = PathBuf::from(path);
    confine_abs_write(&p, scope_id)?;
    if content.len() as u64 > MAX_BINARY_VIEW_BYTES {
        return Err(format!(
            "content too large to save ({} bytes; limit {})",
            content.len(),
            MAX_BINARY_VIEW_BYTES
        ));
    }
    fs::write(&p, content).map_err(|e| e.to_string())
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
#[tauri::command]
pub async fn read_file_bytes(
    path: String,
    project_id: Option<String>,
    pool: tauri::State<'_, RemotePoolState>,
) -> Result<tauri::ipc::Response, String> {
    read_file_bytes_any(path, project_id, pool)
        .await
        .map(tauri::ipc::Response::new)
}

/// The read itself, kept separate from the IPC shape so the routing stays testable
/// and so a Rust caller is not made to build a `Response` to get at bytes.
async fn read_file_bytes_any(
    path: String,
    project_id: Option<String>,
    pool: tauri::State<'_, RemotePoolState>,
) -> Result<Vec<u8>, String> {
    if let Some(pid) = project_id.as_deref() {
        if let Some(target) = crate::services::remote::remote_target_for(pid) {
            // SSH-sync G2: a mirror-local path reads from the LOCAL mirror.
            if !crate::services::remote_sync::is_under_mirror(pid, &path) {
                confine_remote_abs(&target.spec.remote_path, &path)?;
                let (size, _) = remote_metadata(pool.inner(), &target, &path).await?;
                if size > MAX_BINARY_VIEW_BYTES {
                    return Err(format!(
                        "file too large to view ({size} bytes; limit {MAX_BINARY_VIEW_BYTES})"
                    ));
                }
                return remote_read(pool.inner(), &target, &path).await;
            }
        }
    }
    read_file_bytes_local(&path, project_id.as_deref())
}

/// Local-fs byte read — byte-identical pre-Phase-3 body.
pub fn read_file_bytes_local(path: &str, scope_id: Option<&str>) -> Result<Vec<u8>, String> {
    let p = PathBuf::from(path);
    confine_abs_read(&p, scope_id)?;
    let meta = fs::metadata(&p).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".to_string());
    }
    if meta.len() > MAX_BINARY_VIEW_BYTES {
        return Err(format!(
            "file too large to view ({} bytes; limit {})",
            meta.len(),
            MAX_BINARY_VIEW_BYTES
        ));
    }
    fs::read(&p).map_err(|e| e.to_string())
}

/// Return a file's last-modified time as whole seconds since the Unix epoch.
///
/// Used by the in-app text/markdown/TeX viewer to poll for external changes
/// (#43 diff-aware auto-reload). Confined to Tabtivity's known roots (Security #1).
/// Mirrors the `FileEntry.modified_secs` machinery in `list_dir`.
#[tauri::command]
pub async fn file_mtime(
    path: String,
    project_id: Option<String>,
    pool: tauri::State<'_, RemotePoolState>,
) -> Result<u64, String> {
    if let Some(pid) = project_id.as_deref() {
        if let Some(target) = crate::services::remote::remote_target_for(pid) {
            // SSH-sync G2: a mirror-local path is stat'd on the LOCAL fs.
            if !crate::services::remote_sync::is_under_mirror(pid, &path) {
                confine_remote_abs(&target.spec.remote_path, &path)?;
                let (_, modified) = remote_metadata(pool.inner(), &target, &path).await?;
                return Ok(modified.unwrap_or(0));
            }
        }
    }
    file_mtime_local(&path, project_id.as_deref())
}

/// Local-fs mtime — byte-identical pre-Phase-3 body.
pub fn file_mtime_local(path: &str, scope_id: Option<&str>) -> Result<u64, String> {
    let p = PathBuf::from(path);
    confine_abs_read(&p, scope_id)?;
    let meta = fs::metadata(&p).map_err(|e| e.to_string())?;
    let secs = meta
        .modified()
        .map_err(|e| e.to_string())?
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Ok(secs)
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
    static PROJECTS: StateJsonCache<ProjectsList> = StateJsonCache::new();
    static BOXES: StateJsonCache<BoxesList> = StateJsonCache::new();
    let projects = PROJECTS.get("projects.json");
    let boxes = BOXES.get("boxes.json");
    compute_allowed_roots(&projects, &boxes, scope_id, &storage::root_work_dir())
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
        let mut slot = self.0.lock().unwrap_or_else(|e| e.into_inner());
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
        roots
            .iter_mut()
            .for_each(|r| *r = r.canonicalize().unwrap_or_else(|_| r.clone()));
        return roots;
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
        roots
            .iter_mut()
            .for_each(|r| *r = r.canonicalize().unwrap_or_else(|_| r.clone()));
        return roots;
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
    // back to the literal path when the dir does not exist (yet).
    roots
        .iter_mut()
        .for_each(|r| *r = r.canonicalize().unwrap_or_else(|_| r.clone()));
    roots
}

/// A project entry's working directory: the canonical `directory` field when
/// present, otherwise the parent of its `local_file` (which is `<dir>/project.json`).
fn project_dir(entry: &ProjectEntry) -> Option<PathBuf> {
    if let Some(Value::String(d)) = entry.extra.get("directory") {
        if !d.is_empty() {
            return Some(PathBuf::from(d));
        }
    }
    Path::new(&entry.local_file)
        .parent()
        .map(|p| p.to_path_buf())
}

/// A remote project's explicit local-mirror override (`extra["mirror"]`), or
/// `None` when unset/empty or for a local project. Mirrors the resolution in
/// `services::remote_sync::mirror_override` but stays pure (reads the passed
/// entry, not the state dir) so `compute_allowed_roots` remains testable.
fn mirror_override_dir(entry: &ProjectEntry) -> Option<PathBuf> {
    let raw = entry.extra.get("mirror").and_then(Value::as_str)?.trim();
    (!raw.is_empty()).then(|| PathBuf::from(raw))
}

/// Resolve `p` to a canonical path for confinement checks. For existing paths
/// this follows symlinks and `..`; for not-yet-existing paths it canonicalizes
/// the parent and re-joins the final component (so a write target inside an
/// allowed root still validates before creation).
fn resolve_for_confinement(p: &Path) -> PathBuf {
    if p.exists() {
        p.canonicalize().unwrap_or_else(|_| p.to_path_buf())
    } else {
        match p.parent().and_then(|parent| parent.canonicalize().ok()) {
            Some(parent) => parent.join(p.file_name().unwrap_or_default()),
            None => p.to_path_buf(),
        }
    }
}

fn confine_abs(p: &Path, scope_id: Option<&str>) -> Result<(), String> {
    confine_abs_within(p, &allowed_roots(scope_id))
}

/// Pure confinement check against an explicit root set. Empty `roots` (no current
/// project) refuses everything.
fn confine_abs_within(p: &Path, roots: &[PathBuf]) -> Result<(), String> {
    let resolved = resolve_for_confinement(p);
    if roots.iter().any(|root| resolved.starts_with(root)) {
        Ok(())
    } else {
        Err(format!(
            "path '{}' is not in the current project (open that project, or add it to a box with the current one, to access it)",
            p.display()
        ))
    }
}

/// Confine a read of an absolute path to the scope's known roots.
fn confine_abs_read(p: &Path, scope_id: Option<&str>) -> Result<(), String> {
    confine_abs(p, scope_id)
}

/// Confine a write of an absolute path to the scope's known roots.
fn confine_abs_write(p: &Path, scope_id: Option<&str>) -> Result<(), String> {
    confine_abs(p, scope_id)
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

// ── Helpers ───────────────────────────────────────────────────────────────

fn canonical(path: &str) -> Result<PathBuf, String> {
    fs::canonicalize(path).map_err(|e| format!("canonicalize {path}: {e}"))
}

/// Render a (typically canonicalized) path as the string handed to the frontend.
///
/// `fs::canonicalize` returns *verbatim* paths on Windows — `\\?\C:\proj\file`
/// for a drive path, `\\?\UNC\server\share\...` for a network path. The frontend
/// (`src/lib/paths.ts`) expects NATIVE paths (`C:\proj\file`, `\\server\share`)
/// and prefix-matches `entry.path` against the project directory (stored without
/// the verbatim prefix); the `\\?\` prefix would break that match and `file://`
/// URI building. This strips it. No-op on Unix and for paths lacking the prefix.
pub(crate) fn display_path(p: &Path) -> String {
    let s = p.to_string_lossy();
    #[cfg(target_os = "windows")]
    {
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            // `\\?\UNC\server\share` → `\\server\share`
            return format!(r"\\{rest}");
        }
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    s.into_owned()
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

/// Resolve a path that may not exist yet, for confinement: existing paths
/// canonicalize; a dangling link resolves to where it points; a missing path
/// canonicalizes its deepest existing ancestor and applies the rest lexically.
/// The result never keeps a `..` or a link, so neither `missing/../..` nor a
/// planted link to a not-yet-existing file outside can pass a `starts_with`
/// check. Callers write to the returned path, not the one they joined.
pub(crate) fn canonical_or_new(path: &Path) -> Result<PathBuf, String> {
    resolve_new(path, 0).ok_or_else(|| format!("cannot resolve '{}'", path.display()))
}

fn resolve_new(path: &Path, links: u32) -> Option<PathBuf> {
    // The kernel's own ELOOP bound for a chain of links.
    if links > 40 {
        return None;
    }
    if let Ok(c) = path.canonicalize() {
        return Some(c);
    }
    if let Ok(meta) = fs::symlink_metadata(path) {
        if !meta.file_type().is_symlink() {
            // It exists yet will not canonicalize (an unreadable ancestor).
            return None;
        }
        let link = fs::read_link(path).ok()?;
        let target = match path.parent() {
            Some(parent) => parent.join(link),
            None => link,
        };
        return resolve_new(&target, links + 1);
    }
    let parent = resolve_new(path.parent()?, links)?;
    match path.components().next_back()? {
        std::path::Component::Normal(name) => Some(parent.join(name)),
        std::path::Component::CurDir => Some(parent),
        std::path::Component::ParentDir => parent.parent().map(Path::to_path_buf),
        _ => None,
    }
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

/// Enforce that `target` is inside `root` (relative-path project confinement).
pub(crate) fn enforce_confinement(root: &Path, target: &Path) -> Result<(), String> {
    if !target.starts_with(root) {
        return Err(format!(
            "path '{}' escapes project root '{}'",
            target.display(),
            root.display()
        ));
    }
    Ok(())
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
#[tauri::command]
pub fn list_dirs(path: String) -> Result<DirListing, String> {
    let trimmed = path.trim();
    let base = if trimmed.is_empty() {
        crate::paths::home_dir()
    } else {
        PathBuf::from(trimmed)
    };
    // Best-effort canonicalize so `..`/symlinks resolve to a stable absolute
    // path; fall back to the raw path if it can't be canonicalized.
    let base = fs::canonicalize(&base).unwrap_or(base);

    let read = fs::read_dir(&base).map_err(|e| format!("cannot read '{}': {e}", base.display()))?;
    let mut entries: Vec<DirEntry> = read
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| DirEntry {
            name: e.file_name().to_string_lossy().into_owned(),
            path: display_path(&e.path()),
        })
        .collect();
    entries.sort_by_key(|a| a.name.to_lowercase());

    Ok(DirListing {
        path: display_path(&base),
        parent: base.parent().map(display_path),
        entries,
    })
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    // ── The raw-body write's two decoders ──────────────────────────────────
    // `write_file_bytes` takes its path from a header (a header is ASCII; a project
    // path is not) and, on Tauri's postMessage fallback, its content as JSON. Both
    // decode a value the *renderer* wrote, so both are worth pinning down.

    #[test]
    fn percent_decode_reads_what_encode_uri_component_writes() {
        assert_eq!(
            percent_decode(concat!("/home/f/", crate::app_slug!(), "/projects/thesis/thesis.pdf")).as_deref(),
            Some(concat!("/home/f/", crate::app_slug!(), "/projects/thesis/thesis.pdf"))
        );
        // Non-ASCII: `encodeURIComponent("Übung")` is the UTF-8 bytes, percent-escaped.
        assert_eq!(
            percent_decode("%C3%9Cbung/a%20b.pdf").as_deref(),
            Some("Übung/a b.pdf")
        );
        // A `+` is a literal here — encodeURIComponent never writes one for a space.
        assert_eq!(percent_decode("a+b").as_deref(), Some("a+b"));
    }

    #[test]
    fn percent_decode_refuses_a_malformed_escape() {
        assert_eq!(percent_decode("%zz"), None);
        assert_eq!(percent_decode("trailing%"), None);
        // Valid escapes that are not valid UTF-8 are refused rather than lossily
        // replaced: a path is being reconstructed, not text being displayed.
        assert_eq!(percent_decode("%FF%FE"), None);
    }

    #[test]
    fn json_byte_array_accepts_only_bytes() {
        assert_eq!(
            json_byte_array(&serde_json::json!([37, 80, 68, 70])),
            Some(vec![37, 80, 68, 70])
        );
        assert_eq!(json_byte_array(&serde_json::json!([])), Some(vec![]));
        assert_eq!(json_byte_array(&serde_json::json!([256])), None);
        assert_eq!(json_byte_array(&serde_json::json!([-1])), None);
        assert_eq!(
            json_byte_array(&serde_json::json!({ "content": [1] })),
            None
        );
        assert_eq!(json_byte_array(&serde_json::json!("nope")), None);
    }

    // ── join_remote_dir / remote_file_entry ────────────────────────────────

    #[test]
    fn join_remote_dir_root_is_remote_path() {
        assert_eq!(join_remote_dir("/srv/project", ""), "/srv/project");
        // Trailing slash on the root is trimmed.
        assert_eq!(join_remote_dir("/srv/project/", ""), "/srv/project");
    }

    #[test]
    fn join_remote_dir_appends_relative() {
        assert_eq!(
            join_remote_dir("/srv/project", "sub/dir"),
            "/srv/project/sub/dir"
        );
        // A leading slash on the rel is normalized away (no doubled slash).
        assert_eq!(join_remote_dir("/srv/project", "/sub"), "/srv/project/sub");
        assert_eq!(join_remote_dir("/srv/project/", "sub"), "/srv/project/sub");
    }

    #[test]
    fn join_remote_dir_handles_filesystem_root() {
        // remote_path "/" trims to empty; results stay single-leading-slash.
        assert_eq!(join_remote_dir("/", ""), "/");
        assert_eq!(join_remote_dir("/", "etc"), "/etc");
    }

    #[test]
    fn remote_file_entry_maps_path_and_mime() {
        let entry = crate::services::sftp::Entry {
            name: "notes.txt".to_string(),
            is_dir: false,
            size: 42,
            modified_secs: Some(1000),
        };
        let fe = remote_file_entry("/srv/project/src", entry);
        assert_eq!(fe.path, "/srv/project/src/notes.txt");
        assert_eq!(fe.extension.as_deref(), Some(".txt"));
        assert_eq!(fe.mime.as_deref(), Some("text/plain"));
        assert_eq!(fe.size, 42);
        assert_eq!(fe.modified_secs, Some(1000));
        assert_eq!(fe.created_secs, None);
        assert!(!fe.is_dir);
    }

    #[test]
    fn remote_file_entry_dir_has_no_extension() {
        let entry = crate::services::sftp::Entry {
            name: "src".to_string(),
            is_dir: true,
            size: 0,
            modified_secs: None,
        };
        let fe = remote_file_entry("/srv/project", entry);
        assert_eq!(fe.path, "/srv/project/src");
        assert_eq!(fe.extension, None);
        assert_eq!(fe.mime, None);
        assert!(fe.is_dir);
    }

    // ── resolve_text_paths ─────────────────────────────────────────────────

    #[test]
    fn text_paths_resolve_under_the_bases_only() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("project");
        fs::create_dir_all(project.join("docs")).unwrap();
        fs::write(project.join("docs/plan.md"), "x").unwrap();
        fs::write(tmp.path().join("secret.txt"), "x").unwrap();
        let base = project.to_string_lossy().to_string();
        let abs_inside = project.join("docs/plan.md").to_string_lossy().to_string();
        let abs_outside = tmp.path().join("secret.txt").to_string_lossy().to_string();
        let got = resolve_text_paths(
            vec![base],
            vec![
                "docs/plan.md".into(),
                "./docs/../docs/plan.md".into(),
                "docs".into(),
                abs_inside.clone(),
                "missing.md".into(),
                "../secret.txt".into(),
                abs_outside,
            ],
        );
        let found = |i: usize| got[i].as_ref().map(|e| (e.path.clone(), e.is_dir));
        assert_eq!(found(0), Some((abs_inside.clone(), false)));
        assert_eq!(found(1), Some((abs_inside.clone(), false)));
        assert_eq!(found(2).map(|(_, dir)| dir), Some(true));
        assert_eq!(found(3), Some((abs_inside, false)));
        assert_eq!(found(4), None);
        assert_eq!(found(5), None);
        assert_eq!(found(6), None);
    }

    #[test]
    fn text_paths_try_each_base_in_order() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("project");
        let sub = project.join("crate");
        fs::create_dir_all(sub.join("src")).unwrap();
        fs::write(sub.join("src/lib.rs"), "x").unwrap();
        fs::write(project.join("README.md"), "x").unwrap();
        let got = resolve_text_paths(
            vec![sub.to_string_lossy().into(), project.to_string_lossy().into()],
            vec!["src/lib.rs".into(), "README.md".into()],
        );
        assert_eq!(got[0].as_ref().map(|e| e.name.as_str()), Some("lib.rs"));
        assert_eq!(got[1].as_ref().map(|e| e.name.as_str()), Some("README.md"));
    }

    #[cfg(unix)]
    #[test]
    fn text_paths_refuse_a_symlink_out_of_the_base() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("project");
        fs::create_dir_all(&project).unwrap();
        fs::write(tmp.path().join("secret.txt"), "x").unwrap();
        std::os::unix::fs::symlink(tmp.path().join("secret.txt"), project.join("link.txt")).unwrap();
        let got = resolve_text_paths(vec![project.to_string_lossy().into()], vec!["link.txt".into()]);
        assert!(got[0].is_none());
    }

    #[test]
    fn text_paths_skip_the_project_state_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path().join(crate::brand::PROJECT_DIR);
        fs::create_dir_all(&state).unwrap();
        fs::write(state.join("project.json"), "{}").unwrap();
        let rel = format!("{}/project.json", crate::brand::PROJECT_DIR);
        let got = resolve_text_paths(vec![tmp.path().to_string_lossy().into()], vec![rel]);
        assert!(got[0].is_none());
    }

    #[test]
    fn normalize_lexical_folds_dots() {
        assert_eq!(normalize_lexical(Path::new("/a/./b/../c")), PathBuf::from("/a/c"));
        assert_eq!(normalize_lexical(Path::new("/..")), PathBuf::from("/"));
        assert_eq!(normalize_lexical(Path::new("../a")), PathBuf::from("../a"));
    }

    // ── enforce_confinement ────────────────────────────────────────────────

    #[test]
    fn enforce_confinement_allows_exact_root() {
        let root = PathBuf::from("/tmp/project");
        assert!(enforce_confinement(&root, &root).is_ok());
    }

    #[test]
    fn enforce_confinement_allows_child() {
        let root = PathBuf::from("/tmp/project");
        let child = PathBuf::from("/tmp/project/src/main.rs");
        assert!(enforce_confinement(&root, &child).is_ok());
    }

    #[test]
    fn enforce_confinement_blocks_parent_escape() {
        let root = PathBuf::from("/tmp/project");
        let parent = PathBuf::from("/tmp");
        assert!(enforce_confinement(&root, &parent).is_err());
    }

    #[test]
    fn enforce_confinement_blocks_sibling() {
        let root = PathBuf::from("/tmp/project");
        let sibling = PathBuf::from("/tmp/other");
        assert!(enforce_confinement(&root, &sibling).is_err());
    }

    #[test]
    fn enforce_confinement_blocks_absolute_escape() {
        let root = PathBuf::from("/tmp/project");
        let escape = PathBuf::from("/etc/passwd");
        assert!(enforce_confinement(&root, &escape).is_err());
    }

    #[test]
    fn enforce_confinement_error_message_mentions_root() {
        let root = PathBuf::from("/tmp/project");
        let escape = PathBuf::from("/etc/passwd");
        let err = enforce_confinement(&root, &escape).unwrap_err();
        assert!(
            err.contains("/tmp/project"),
            "error must mention root: {err}"
        );
    }

    // ── dir_size_breakdown ──────────────────────────────────────────────────

    fn git_available() -> bool {
        crate::paths::command_no_window("git")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    fn init_repo(dir: &Path) {
        let run = |args: &[&str]| {
            assert!(
                crate::paths::command_no_window("git")
                    .args(args)
                    .current_dir(dir)
                    .output()
                    .expect("git command should run")
                    .status
                    .success(),
                "git {args:?} failed"
            );
        };
        run(&["init"]);
        run(&["config", "user.email", "test@example.com"]);
        run(&["config", "user.name", "Test User"]);
    }

    #[test]
    fn dir_size_breakdown_splits_ignored_from_tracked() {
        if !git_available() {
            eprintln!("git not on PATH — skipping dir_size_breakdown_splits_ignored_from_tracked");
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        init_repo(dir);

        std::fs::write(dir.join(".gitignore"), "whole/\n").unwrap();
        std::fs::create_dir(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/main.rs"), "12345").unwrap(); // 5 bytes, tracked/untracked
        std::fs::create_dir_all(dir.join("src/whole/sub")).unwrap();
        std::fs::write(dir.join("src/whole/a.txt"), "1234567890").unwrap(); // 10 bytes, ignored
        std::fs::write(dir.join("src/whole/sub/b.txt"), "12345678901234567890").unwrap(); // 20 bytes, ignored

        let breakdown =
            dir_size_breakdown_local(&dir.to_string_lossy(), "src", &[]).expect("breakdown");
        assert_eq!(breakdown.total, 35);
        assert_eq!(breakdown.ignored, 30);
    }

    #[test]
    fn dir_size_breakdown_no_git_yields_zero_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(dir.join("a.txt"), "hello").unwrap();

        let breakdown =
            dir_size_breakdown_local(&dir.to_string_lossy(), "", &[]).expect("breakdown");
        assert_eq!(breakdown.total, 5);
        assert_eq!(breakdown.ignored, 0);
    }

    // ── copy_path / move_path ──────────────────────────────────────────────

    /// A rename that fails for a reason other than a cross-device move must be
    /// reported as it is. The old fallback copied the file first and only then
    /// failed to remove the source, leaving a duplicate behind an error.
    #[cfg(unix)]
    #[test]
    fn move_path_surfaces_a_non_cross_device_rename_error() {
        use std::os::unix::fs::PermissionsExt;
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_string_lossy().to_string();
        let locked = tmp.path().join("locked");
        std::fs::create_dir(&locked).unwrap();
        std::fs::write(locked.join("a.txt"), "hello").unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();

        let result =
            move_path_blocking(dir.clone(), "locked/a.txt".into(), dir.clone(), "b.txt".into());
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();

        assert!(result.is_err(), "EACCES must surface: {result:?}");
        assert!(!tmp.path().join("b.txt").exists(), "no copy was made");
        assert!(locked.join("a.txt").exists(), "the source is untouched");
    }

    #[test]
    fn copy_path_duplicates_a_file() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_string_lossy().to_string();
        std::fs::write(tmp.path().join("a.txt"), "hello").unwrap();

        copy_path_blocking(dir.clone(), "a.txt".into(), dir.clone(), "b.txt".into()).unwrap();

        assert_eq!(
            std::fs::read_to_string(tmp.path().join("a.txt")).unwrap(),
            "hello"
        );
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("b.txt")).unwrap(),
            "hello"
        );
    }

    #[test]
    fn copy_path_recurses_into_directories() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_string_lossy().to_string();
        std::fs::create_dir(tmp.path().join("src")).unwrap();
        std::fs::write(tmp.path().join("src/main.rs"), "fn main() {}").unwrap();

        copy_path_blocking(dir.clone(), "src".into(), dir.clone(), "src2".into()).unwrap();

        assert_eq!(
            std::fs::read_to_string(tmp.path().join("src2/main.rs")).unwrap(),
            "fn main() {}"
        );
        assert!(tmp.path().join("src/main.rs").exists());
    }

    #[test]
    fn copy_path_refuses_existing_destination() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_string_lossy().to_string();
        std::fs::write(tmp.path().join("a.txt"), "1").unwrap();
        std::fs::write(tmp.path().join("b.txt"), "2").unwrap();

        let err = copy_path_blocking(dir.clone(), "a.txt".into(), dir.clone(), "b.txt".into()).unwrap_err();
        assert!(err.contains("already exists"), "{err}");
        // The pre-existing destination is untouched.
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("b.txt")).unwrap(),
            "2"
        );
    }

    // ── extract_archive ────────────────────────────────────────────────────

    /// Write a minimal .zip (stored, no compression) at `path` from
    /// (entry-name, contents) pairs. An entry name ending in `/` is a directory.
    fn write_test_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts: zip::write::FileOptions<()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, data) in entries {
            if name.ends_with('/') {
                zip.add_directory(*name, opts).unwrap();
            } else {
                use std::io::Write;
                zip.start_file(*name, opts).unwrap();
                zip.write_all(data).unwrap();
            }
        }
        zip.finish().unwrap();
    }

    #[test]
    fn extract_archive_unpacks_into_named_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_string_lossy().to_string();
        write_test_zip(
            &tmp.path().join("bundle.zip"),
            &[("a.txt", b"hello"), ("sub/", b""), ("sub/b.txt", b"world")],
        );

        let folder = extract_archive_blocking(dir.clone(), "bundle.zip".into()).unwrap();

        assert_eq!(folder, "bundle");
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("bundle/a.txt")).unwrap(),
            "hello"
        );
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("bundle/sub/b.txt")).unwrap(),
            "world"
        );
    }

    #[test]
    fn extract_archive_dedupes_existing_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_string_lossy().to_string();
        std::fs::create_dir(tmp.path().join("bundle")).unwrap();
        write_test_zip(&tmp.path().join("bundle.zip"), &[("a.txt", b"x")]);

        let folder = extract_archive_blocking(dir.clone(), "bundle.zip".into()).unwrap();

        assert_eq!(folder, "bundle (1)");
        assert!(tmp.path().join("bundle (1)/a.txt").exists());
    }

    #[test]
    fn extract_archive_ignores_zip_slip_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_string_lossy().to_string();
        // A crafted entry trying to escape the destination via `..`.
        write_test_zip(
            &tmp.path().join("evil.zip"),
            &[("../escaped.txt", b"pwned"), ("safe.txt", b"ok")],
        );

        extract_archive_blocking(dir.clone(), "evil.zip".into()).unwrap();

        // The traversal entry is dropped; the sibling escape file never appears.
        assert!(!tmp.path().join("escaped.txt").exists());
        assert!(tmp.path().join("evil/safe.txt").exists());
    }

    #[test]
    fn copy_path_refuses_directory_into_itself() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_string_lossy().to_string();
        std::fs::create_dir(tmp.path().join("src")).unwrap();

        let err =
            copy_path_blocking(dir.clone(), "src".into(), dir.clone(), "src/inner".into()).unwrap_err();
        assert!(err.contains("into itself"), "{err}");
    }

    #[test]
    fn move_path_relocates_a_file() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_string_lossy().to_string();
        std::fs::write(tmp.path().join("a.txt"), "hello").unwrap();

        move_path_blocking(dir.clone(), "a.txt".into(), dir.clone(), "sub/b.txt".into()).unwrap();

        assert!(!tmp.path().join("a.txt").exists());
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("sub/b.txt")).unwrap(),
            "hello"
        );
    }

    /// Two DIFFERENT roots — the box view's cross-project drag-and-drop (and a
    /// side-panel → other project's Files tab drop) depend on this shape: the
    /// frontend routes the drop to `dest_project_dir = <target tree's root>`.
    /// Locks that a folder moves wholesale into the other root and leaves
    /// nothing behind in the source project.
    #[test]
    fn move_path_moves_a_folder_between_roots() {
        let src = tempfile::tempdir().unwrap();
        let dest = tempfile::tempdir().unwrap();
        std::fs::create_dir(src.path().join("data")).unwrap();
        std::fs::write(src.path().join("data/x.txt"), "payload").unwrap();
        std::fs::create_dir(dest.path().join("incoming")).unwrap();

        move_path_blocking(
            src.path().to_string_lossy().to_string(),
            "data".into(),
            dest.path().to_string_lossy().to_string(),
            "incoming/data".into(),
        )
        .unwrap();

        assert!(!src.path().join("data").exists());
        assert_eq!(
            std::fs::read_to_string(dest.path().join("incoming/data/x.txt")).unwrap(),
            "payload"
        );
    }

    // ── import_external_file ───────────────────────────────────────────────

    #[test]
    fn import_external_file_copies_into_subfolder() {
        let ext = tempfile::tempdir().unwrap();
        std::fs::write(ext.path().join("photo.png"), "img").unwrap();
        let proj = tempfile::tempdir().unwrap();
        std::fs::create_dir(proj.path().join("assets")).unwrap();

        let rel = import_external_file_blocking(
            proj.path().to_string_lossy().to_string(),
            ext.path().join("photo.png").to_string_lossy().to_string(),
            "assets".into(),
            false,
            None,
        )
        .unwrap();

        assert_eq!(rel, "assets/photo.png");
        assert_eq!(
            std::fs::read_to_string(proj.path().join("assets/photo.png")).unwrap(),
            "img"
        );
        // Source is left in place (copy, not move).
        assert!(ext.path().join("photo.png").exists());
    }

    #[test]
    fn import_external_file_renames_on_collision() {
        let ext = tempfile::tempdir().unwrap();
        std::fs::write(ext.path().join("a.txt"), "new").unwrap();
        let proj = tempfile::tempdir().unwrap();
        std::fs::write(proj.path().join("a.txt"), "old").unwrap();

        let rel = import_external_file_blocking(
            proj.path().to_string_lossy().to_string(),
            ext.path().join("a.txt").to_string_lossy().to_string(),
            "".into(),
            false,
            None,
        )
        .unwrap();

        assert_eq!(rel, "a (1).txt");
        // The pre-existing file is untouched; the import lands beside it.
        assert_eq!(
            std::fs::read_to_string(proj.path().join("a.txt")).unwrap(),
            "old"
        );
        assert_eq!(
            std::fs::read_to_string(proj.path().join("a (1).txt")).unwrap(),
            "new"
        );
    }

    #[test]
    fn import_external_file_replace_overwrites() {
        let ext = tempfile::tempdir().unwrap();
        std::fs::write(ext.path().join("a.txt"), "new").unwrap();
        let proj = tempfile::tempdir().unwrap();
        std::fs::write(proj.path().join("a.txt"), "old").unwrap();

        let rel = import_external_file_blocking(
            proj.path().to_string_lossy().to_string(),
            ext.path().join("a.txt").to_string_lossy().to_string(),
            "".into(),
            true,
            None,
        )
        .unwrap();

        // Same name, content overwritten — no " (1)" copy created.
        assert_eq!(rel, "a.txt");
        assert_eq!(
            std::fs::read_to_string(proj.path().join("a.txt")).unwrap(),
            "new"
        );
        assert!(!proj.path().join("a (1).txt").exists());
    }

    #[test]
    fn import_external_file_honours_a_chosen_name() {
        let ext = tempfile::tempdir().unwrap();
        std::fs::write(ext.path().join("a.txt"), "new").unwrap();
        let proj = tempfile::tempdir().unwrap();
        std::fs::write(proj.path().join("a.txt"), "old").unwrap();

        // The collision prompt's "keep both, as …": the second copy is named by
        // the user rather than suffixed.
        let rel = import_external_file_blocking(
            proj.path().to_string_lossy().to_string(),
            ext.path().join("a.txt").to_string_lossy().to_string(),
            "".into(),
            false,
            Some("  a-draft.txt  ".into()),
        )
        .unwrap();

        assert_eq!(rel, "a-draft.txt");
        assert_eq!(
            std::fs::read_to_string(proj.path().join("a.txt")).unwrap(),
            "old"
        );
        assert_eq!(
            std::fs::read_to_string(proj.path().join("a-draft.txt")).unwrap(),
            "new"
        );
    }

    #[test]
    fn chosen_name_that_also_collides_is_suffixed_not_overwritten() {
        let ext = tempfile::tempdir().unwrap();
        std::fs::write(ext.path().join("a.txt"), "new").unwrap();
        let proj = tempfile::tempdir().unwrap();
        std::fs::write(proj.path().join("a.txt"), "old").unwrap();
        std::fs::write(proj.path().join("taken.txt"), "mine").unwrap();

        // Without `replace`, a name is a request and never an overwrite — the
        // prompt's suggestion can be stale by the time the copy runs.
        let rel = import_external_file_blocking(
            proj.path().to_string_lossy().to_string(),
            ext.path().join("a.txt").to_string_lossy().to_string(),
            "".into(),
            false,
            Some("taken.txt".into()),
        )
        .unwrap();

        assert_eq!(rel, "taken (1).txt");
        assert_eq!(
            std::fs::read_to_string(proj.path().join("taken.txt")).unwrap(),
            "mine"
        );
    }

    #[test]
    fn import_external_file_rejects_a_chosen_name_with_a_separator() {
        let ext = tempfile::tempdir().unwrap();
        std::fs::write(ext.path().join("a.txt"), "x").unwrap();
        let proj = tempfile::tempdir().unwrap();
        std::fs::create_dir(proj.path().join("sub")).unwrap();

        for name in ["../escape.txt", "sub/a.txt", "..", "."] {
            let err = import_external_file_blocking(
                proj.path().to_string_lossy().to_string(),
                ext.path().join("a.txt").to_string_lossy().to_string(),
                "".into(),
                false,
                Some(name.into()),
            )
            .unwrap_err();
            assert!(err.contains("invalid file name"), "{name}: {err}");
        }
        // Nothing landed anywhere.
        assert!(!proj.path().join("sub/a.txt").exists());
    }

    #[test]
    fn blank_chosen_name_falls_back_to_the_source_name() {
        let ext = tempfile::tempdir().unwrap();
        std::fs::write(ext.path().join("a.txt"), "x").unwrap();
        let proj = tempfile::tempdir().unwrap();

        let rel = import_external_file_blocking(
            proj.path().to_string_lossy().to_string(),
            ext.path().join("a.txt").to_string_lossy().to_string(),
            "".into(),
            false,
            Some("   ".into()),
        )
        .unwrap();
        assert_eq!(rel, "a.txt");
    }

    #[test]
    fn project_path_exists_reports_presence() {
        let proj = tempfile::tempdir().unwrap();
        std::fs::write(proj.path().join("here.txt"), "x").unwrap();
        let dir = proj.path().to_string_lossy().to_string();
        assert!(project_path_exists(dir.clone(), "here.txt".into()).unwrap());
        assert!(!project_path_exists(dir, "missing.txt".into()).unwrap());
    }

    #[test]
    fn import_external_file_recurses_into_directories() {
        let ext = tempfile::tempdir().unwrap();
        std::fs::create_dir(ext.path().join("pkg")).unwrap();
        std::fs::write(ext.path().join("pkg/mod.rs"), "fn x() {}").unwrap();
        let proj = tempfile::tempdir().unwrap();

        let rel = import_external_file_blocking(
            proj.path().to_string_lossy().to_string(),
            ext.path().join("pkg").to_string_lossy().to_string(),
            "".into(),
            false,
            None,
        )
        .unwrap();

        assert_eq!(rel, "pkg");
        assert_eq!(
            std::fs::read_to_string(proj.path().join("pkg/mod.rs")).unwrap(),
            "fn x() {}"
        );
    }

    #[test]
    fn import_external_file_rejects_escaping_dest() {
        let ext = tempfile::tempdir().unwrap();
        std::fs::write(ext.path().join("a.txt"), "x").unwrap();
        let proj = tempfile::tempdir().unwrap();

        let err = import_external_file_blocking(
            proj.path().to_string_lossy().to_string(),
            ext.path().join("a.txt").to_string_lossy().to_string(),
            "../escape".into(),
            false,
            None,
        )
        .unwrap_err();
        assert!(err.contains("invalid path component"), "{err}");
    }

    // ── list_project_endings ───────────────────────────────────────────────

    #[test]
    #[cfg(unix)]
    fn list_project_endings_does_not_follow_self_symlink() {
        // A symlink pointing back at the project root (`repo -> .`) must not
        // cause the recursive ending scan to loop. Before the fix this hung
        // until the OS path-length limit, walking the tree hundreds of times.
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("main.rs"), "fn main() {}").unwrap();
        std::fs::create_dir(tmp.path().join("src")).unwrap();
        std::fs::write(tmp.path().join("src/lib.py"), "x = 1").unwrap();
        std::os::unix::fs::symlink(tmp.path(), tmp.path().join("repo")).unwrap();

        let endings = list_project_endings_blocking(tmp.path().to_string_lossy().to_string()).unwrap();

        // Real file endings are collected; the self-symlink is never entered.
        assert!(endings.contains(&".rs".to_string()));
        assert!(endings.contains(&".py".to_string()));
    }

    // ── write_project_file / rename_path ────────────────────────────────────

    #[test]
    fn write_project_file_creates_nested_file_inside_project() {
        let tmp = tempfile::tempdir().unwrap();
        write_project_file_local(
            &tmp.path().to_string_lossy(),
            concat!(".", crate::app_slug!(), "/scaffold-fill-claude.md"),
            "fill AGENTS.md",
        )
        .unwrap();

        let content =
            std::fs::read_to_string(tmp.path().join(concat!(".", crate::app_slug!(), "/scaffold-fill-claude.md"))).unwrap();
        assert_eq!(content, "fill AGENTS.md");
    }

    #[test]
    fn rename_path_renames_file_in_place() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("old.txt"), "content").unwrap();

        rename_path_local(&tmp.path().to_string_lossy(), "old.txt", "new.txt").unwrap();

        assert!(!tmp.path().join("old.txt").exists());
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("new.txt")).unwrap(),
            "content"
        );
    }

    #[test]
    fn rename_path_rejects_non_bare_names() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.txt"), "x").unwrap();
        let dir = tmp.path().to_string_lossy().to_string();

        for bad in ["", " ", ".", "..", "sub/name", "..\\name", "a\0b"] {
            let err = rename_path_local(&dir, "a.txt", bad);
            assert!(err.is_err(), "name {bad:?} must be rejected");
        }
        assert!(tmp.path().join("a.txt").exists(), "file must be untouched");
    }

    #[test]
    fn write_project_file_blocks_parent_escape() {
        let tmp = tempfile::tempdir().unwrap();
        let err =
            write_project_file_local(&tmp.path().to_string_lossy(), "../outside.md", "escape")
                .unwrap_err();

        assert!(
            err.contains("escapes project root"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn write_project_file_blocks_escape_through_a_missing_folder() {
        // `missing/..` cannot be canonicalized, so the confinement check used
        // to compare the raw path — whose components still start with the root.
        let outer = tempfile::tempdir().unwrap();
        let root = outer.path().join("project");
        std::fs::create_dir(&root).unwrap();
        let dir = root.to_string_lossy().to_string();

        assert!(write_project_file_local(&dir, "missing/../../outside.md", "x").is_err());
        assert!(write_project_file_bytes_local(&dir, "missing/../../outside.png", b"x").is_err());
        assert!(!outer.path().join("outside.md").exists());
        assert!(!outer.path().join("outside.png").exists());
    }

    #[cfg(unix)]
    #[test]
    fn write_project_file_never_follows_a_dangling_link_out_of_the_project() {
        // A link to a not-yet-existing file outside passes `exists()` as false,
        // so only its parent was canonicalized — and the write then created
        // the link's target outside the project.
        let outer = tempfile::tempdir().unwrap();
        let root = outer.path().join("project");
        std::fs::create_dir_all(root.join(concat!(crate::app_slug!(), "-screenshots"))).unwrap();
        let outside = outer.path().join("planted.desktop");
        std::os::unix::fs::symlink(&outside, root.join(concat!(crate::app_slug!(), "-screenshots/shot.png"))).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("notes.md")).unwrap();
        let dir = root.to_string_lossy().to_string();

        assert!(
            write_project_file_bytes_local(&dir, concat!(crate::app_slug!(), "-screenshots/shot.png"), b"png").is_err()
        );
        assert!(write_project_file_local(&dir, "notes.md", "text").is_err());
        assert!(!outside.exists(), "nothing may land outside the project");
    }

    #[cfg(unix)]
    #[test]
    fn write_project_file_still_saves_through_a_link_inside_the_project() {
        // A symlinked file whose target is inside the project is the user's own
        // layout; saving it must keep writing the target, as before.
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("real.md"), "old").unwrap();
        std::os::unix::fs::symlink(tmp.path().join("real.md"), tmp.path().join("alias.md"))
            .unwrap();

        write_project_file_local(&tmp.path().to_string_lossy(), "alias.md", "new").unwrap();

        assert_eq!(
            std::fs::read_to_string(tmp.path().join("real.md")).unwrap(),
            "new"
        );
    }

    // ── Remote path join / confinement (mount-free remote, Phase 3) ─────────

    #[test]
    fn remote_join_confined_joins_clean_rel() {
        assert_eq!(
            remote_join_confined("/srv/project", "src/main.rs").unwrap(),
            "/srv/project/src/main.rs"
        );
        // Empty rel resolves to the project root itself.
        assert_eq!(
            remote_join_confined("/srv/project", "").unwrap(),
            "/srv/project"
        );
    }

    #[test]
    fn remote_join_confined_rejects_traversal() {
        assert!(remote_join_confined("/srv/project", "../escape").is_err());
        assert!(remote_join_confined("/srv/project", "a/../../b").is_err());
        // A leading slash (absolute rel) is a RootDir component → rejected, so a
        // caller can never pivot the join off the project root.
        assert!(remote_join_confined("/srv/project", "/etc/passwd").is_err());
    }

    #[test]
    fn confine_remote_abs_allows_paths_under_root() {
        assert!(confine_remote_abs("/srv/project", "/srv/project").is_ok());
        assert!(confine_remote_abs("/srv/project", "/srv/project/src/main.rs").is_ok());
        // Trailing slash on the root is tolerated.
        assert!(confine_remote_abs("/srv/project/", "/srv/project/a").is_ok());
    }

    #[test]
    fn confine_remote_abs_blocks_outside_and_prefix_sibling() {
        // A sibling that merely shares a string prefix must NOT be inside.
        assert!(confine_remote_abs("/srv/project", "/srv/project-evil/loot").is_err());
        // Unrelated absolute path.
        assert!(confine_remote_abs("/srv/project", "/etc/passwd").is_err());
        // Parent-dir traversal is refused even if it would resolve back inside.
        assert!(confine_remote_abs("/srv/project", "/srv/project/../secret").is_err());
    }

    // ── Absolute-path confinement (Security #1) ─────────────────────────────

    fn entry(id: &str, status: &str, dir: &str) -> ProjectEntry {
        let mut extra = std::collections::HashMap::new();
        extra.insert("directory".to_string(), Value::String(dir.to_string()));
        ProjectEntry {
            id: id.to_string(),
            name: id.to_string(),
            status: status.to_string(),
            position: 0,
            local_file: format!("{dir}/project.json"),
            extra,
        }
    }

    /// The root terminal folder the tests thread through `compute_allowed_roots`.
    const ROOT_WORK: &str = concat!("/home/u/", crate::app_slug!(), "/root");

    #[test]
    fn state_json_cache_follows_a_same_length_rewrite() {
        // A project switch rewrites projects.json in place with two statuses
        // swapped — same length, possibly the same mtime tick. The cache must
        // still hand back the new current project.
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("projects.json");
        let write = |x: &str, y: &str| {
            let list = vec![entry("x", x, "/home/u/code/projectx"), entry("y", y, "/home/u/code/projecty")];
            fs::write(&path, serde_json::to_string(&list).unwrap()).unwrap();
        };
        let cache: StateJsonCache<ProjectsList> = StateJsonCache::new();
        let current = |list: &ProjectsList| list.iter().find(|e| e.status == "current").unwrap().id.clone();

        write("current", "stopped");
        let first = cache.load(path.clone());
        assert_eq!(current(&first), "x");
        assert!(std::sync::Arc::ptr_eq(&first, &cache.load(path.clone())), "unchanged bytes reuse the parse");

        write("stopped", "current");
        assert_eq!(current(&cache.load(path.clone())), "y");

        fs::write(&path, "{ not json").unwrap();
        assert!(cache.load(path.clone()).is_empty(), "unparseable fails closed");
        fs::remove_file(&path).unwrap();
        assert!(cache.load(path).is_empty(), "absent fails closed");
    }

    #[test]
    fn allowed_roots_scoped_to_named_project_not_current() {
        // The scope is the *viewer's own* project, not whichever is current. A
        // viewer owned by Y stays able to reach Y even while X is current — and
        // X's tree is NOT reachable through Y's scope (per-project isolation).
        let projects = vec![
            entry("x", "current", "/home/u/code/projectx"),
            entry("y", "inactive", "/home/u/code/projecty"),
        ];
        let roots = compute_allowed_roots(&projects, &Vec::new(), Some("y"), Path::new(ROOT_WORK));
        assert!(
            roots.iter().any(|r| r.ends_with("projecty")),
            "the scope project must be reachable even when it is not current"
        );
        assert!(
            !roots.iter().any(|r| r.ends_with("projectx")),
            "a project outside the scope must not be reachable"
        );
    }

    #[test]
    fn allowed_roots_falls_back_to_current_when_no_scope() {
        // No scope id (root scope / legacy caller) → the current project.
        let projects = vec![
            entry("x", "current", "/home/u/code/projectx"),
            entry("y", "inactive", "/home/u/code/projecty"),
        ];
        let roots = compute_allowed_roots(&projects, &Vec::new(), None, Path::new(ROOT_WORK));
        assert!(roots.iter().any(|r| r.ends_with("projectx")));
        assert!(!roots.iter().any(|r| r.ends_with("projecty")));
    }

    #[test]
    fn allowed_roots_includes_box_siblings_of_scope() {
        let projects = vec![
            entry("x", "current", "/home/u/code/projectx"),
            entry("y", "inactive", "/home/u/code/projecty"),
            entry("z", "inactive", "/home/u/code/projectz"),
        ];
        let boxes = vec![crate::schema::boxes::ProjectBox {
            id: "b1".to_string(),
            name: "grp".to_string(),
            member_ids: vec!["y".to_string(), "z".to_string()],
            ..Default::default()
        }];
        // Scope is Y; its box sibling Z is co-accessible, X (current) is not.
        let roots = compute_allowed_roots(&projects, &boxes, Some("y"), Path::new(ROOT_WORK));
        assert!(roots.iter().any(|r| r.ends_with("projecty")));
        assert!(roots.iter().any(|r| r.ends_with("projectz")));
        assert!(
            !roots.iter().any(|r| r.ends_with("projectx")),
            "a project outside the scope's box must not be reachable"
        );
    }

    #[test]
    fn allowed_roots_includes_remote_mirror_override() {
        // A remote (SSH) project's browsable tree is its local mirror, relocated
        // outside the state dir via extra["mirror"]. That mirror must be reachable
        // or opening a mirrored local file fails confinement (#28k regression).
        let mut r = entry(
            "r",
            "current",
            concat!("/home/u/.local/share/", crate::app_slug!(), "/remote-projects/r"),
        );
        r.extra.insert(
            "mirror".to_string(),
            Value::String(concat!("/home/u/", crate::app_slug!(), "/projects-ssh/myproj").to_string()),
        );
        let roots = compute_allowed_roots(&vec![r], &Vec::new(), Some("r"), Path::new(ROOT_WORK));
        assert!(
            roots.iter().any(|p| p.ends_with("projects-ssh/myproj")),
            "the relocated local mirror must be an allowed root"
        );
    }

    #[test]
    fn allowed_roots_empty_when_scope_unknown() {
        let projects = vec![entry("x", "current", "/home/u/code/projectx")];
        // An unknown scope id resolves to no project → fail closed.
        assert!(
            compute_allowed_roots(&projects, &Vec::new(), Some("nope"), Path::new(ROOT_WORK))
                .is_empty()
        );
    }

    fn mk_box(id: &str, members: &[&str], folder: Option<&str>) -> crate::schema::boxes::ProjectBox {
        crate::schema::boxes::ProjectBox {
            id: id.to_string(),
            name: id.to_string(),
            member_ids: members.iter().map(|s| s.to_string()).collect(),
            folder: folder.map(|s| s.to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn allowed_roots_box_scope_covers_folder_and_member_roots() {
        let mut y = entry("y", "inactive", "/home/u/code/projecty");
        y.extra.insert(
            "mirror".to_string(),
            Value::String(concat!("/home/u/", crate::app_slug!(), "/projects-ssh/y").to_string()),
        );
        let projects = vec![entry("x", "current", "/home/u/code/projectx"), y];
        let boxes = vec![mk_box("b1", &["x", "y"], Some(concat!("/home/u/", crate::app_slug!(), "/boxes/b1")))];
        let roots = compute_allowed_roots(&projects, &boxes, Some("box:b1"), Path::new(ROOT_WORK));
        assert!(roots.iter().any(|r| r.ends_with("boxes/b1")));
        assert!(roots.iter().any(|r| r.ends_with("projectx")));
        assert!(roots.iter().any(|r| r.ends_with("projecty")));
        assert!(roots.iter().any(|r| r.ends_with("projects-ssh/y")));
        // A box viewer is not the root scope.
        assert!(!roots.iter().any(|r| r == Path::new(ROOT_WORK)));
    }

    #[test]
    fn allowed_roots_box_scope_excludes_non_members() {
        let projects = vec![
            entry("x", "current", "/home/u/code/projectx"),
            entry("y", "inactive", "/home/u/code/projecty"),
        ];
        let boxes = vec![mk_box("b1", &["y"], None)];
        let roots = compute_allowed_roots(&projects, &boxes, Some("box:b1"), Path::new(ROOT_WORK));
        assert!(roots.iter().any(|r| r.ends_with("projecty")));
        assert!(
            !roots.iter().any(|r| r.ends_with("projectx")),
            "the current project is not reachable through a box it is not in"
        );
    }

    #[test]
    fn allowed_roots_unknown_box_scope_fails_closed() {
        let projects = vec![entry("x", "current", "/home/u/code/projectx")];
        let boxes = vec![mk_box("b1", &["x"], None)];
        assert!(compute_allowed_roots(
            &projects,
            &boxes,
            Some("box:ghost"),
            Path::new(ROOT_WORK)
        )
        .is_empty());
    }

    #[test]
    fn allowed_roots_no_current_and_no_scope_is_root_folder_only() {
        // With no owning project and no current one, the root scope can still
        // read its own folder — and nothing else.
        let projects = vec![entry("x", "inactive", "/home/u/code/projectx")];
        let roots = compute_allowed_roots(&projects, &Vec::new(), None, Path::new(ROOT_WORK));
        assert_eq!(roots, vec![PathBuf::from(ROOT_WORK)]);
    }

    #[test]
    fn allowed_roots_root_scope_includes_root_folder_beside_current() {
        // The ROOT scope (scope_id None) reads the root terminal folder — the
        // regression here was a PDF opened from the root tree failing every
        // byte read and hanging on "Loading" (~/tabtivity/root was never a root).
        let projects = vec![entry("x", "current", "/home/u/code/projectx")];
        let roots = compute_allowed_roots(&projects, &Vec::new(), None, Path::new(ROOT_WORK));
        assert!(roots.iter().any(|r| r == Path::new(ROOT_WORK)));
        assert!(roots.iter().any(|r| r.ends_with("projectx")));
    }

    #[test]
    fn allowed_roots_project_scope_excludes_root_folder() {
        // A project-scoped viewer stays project-isolated: it does not gain the
        // root terminal folder.
        let projects = vec![entry("x", "current", "/home/u/code/projectx")];
        let roots = compute_allowed_roots(&projects, &Vec::new(), Some("x"), Path::new(ROOT_WORK));
        assert!(!roots.iter().any(|r| r == Path::new(ROOT_WORK)));
    }

    #[test]
    fn confine_abs_within_blocks_outside_roots() {
        // With the current project at projectx, classic exploit targets and a
        // sibling project alike must be refused.
        let roots = vec![PathBuf::from("/home/u/code/projectx")];
        for p in [
            "/home/u/.ssh/id_rsa",
            "/home/u/.aws/credentials",
            "/etc/passwd",
            "/home/u/code/projecty/secret", // sibling project
        ] {
            assert!(
                confine_abs_within(Path::new(p), &roots).is_err(),
                "must refuse {p}"
            );
        }
    }

    #[test]
    fn confine_abs_within_allows_paths_inside_current_project() {
        let roots = vec![PathBuf::from("/home/u/code/projectx")];
        // A file inside the project tree must pass even before it exists (write
        // target validation canonicalizes the parent).
        let inside = Path::new("/home/u/code/projectx/src/main.rs");
        assert!(confine_abs_within(inside, &roots).is_ok());
    }

    #[test]
    fn confine_abs_within_blocks_prefix_sibling() {
        // /home/u/code/projectx-evil must NOT be treated as inside projectx.
        let roots = vec![PathBuf::from("/home/u/code/projectx")];
        let sibling = Path::new("/home/u/code/projectx-evil/loot");
        assert!(confine_abs_within(sibling, &roots).is_err());
    }

    #[test]
    fn confine_abs_within_empty_roots_refuses_everything() {
        assert!(confine_abs_within(Path::new("/home/u/code/projectx/a"), &[]).is_err());
    }

    // ── display_path ───────────────────────────────────────────────────────

    #[test]
    fn display_path_is_noop_without_verbatim_prefix() {
        // A plain path is returned unchanged on every platform.
        let p = if cfg!(target_os = "windows") {
            r"C:\Users\u\proj\file.txt"
        } else {
            "/home/u/proj/file.txt"
        };
        assert_eq!(display_path(Path::new(p)), p);
    }

    #[test]
    fn excluded_rel_set_normalises_every_spelling_to_one() {
        let set = excluded_rel_set(&[
            "venv".into(),
            "./data/raw".into(),
            "/results/".into(),
            "a\\b".into(),
            "  spaced  ".into(),
            String::new(),
            "/".into(),
        ]);
        assert!(set.contains("venv"));
        assert!(set.contains("data/raw"));
        assert!(set.contains("results"));
        assert!(set.contains("a/b"));
        assert!(set.contains("spaced"));
        // Empty and separator-only entries are dropped rather than becoming an
        // empty-string key, which would match the project root and prune the lot.
        assert_eq!(set.len(), 5);
    }

    #[test]
    fn dir_size_skips_an_excluded_subtree() {
        let tmp = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-excl-{}"), std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("keep")).unwrap();
        fs::create_dir_all(tmp.join("venv/lib")).unwrap();
        fs::write(tmp.join("keep/a.txt"), vec![b'x'; 100]).unwrap();
        fs::write(tmp.join("venv/lib/big.bin"), vec![b'x'; 5000]).unwrap();
        let root = tmp.to_string_lossy().to_string();

        let all = dir_size_local(&root, "", &[]).unwrap();
        assert_eq!(all, 5100, "baseline walks everything");

        let pruned = dir_size_local(&root, "", &["venv".into()]).unwrap();
        assert_eq!(pruned, 100, "the excluded subtree contributes nothing");

        // Exclusions are project-root-relative, so they still bite when the walk
        // starts deeper — here the walk root IS the excluded folder's parent.
        let nested = dir_size_local(&root, "venv", &["venv/lib".into()]).unwrap();
        assert_eq!(nested, 0);

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn display_path_strips_windows_verbatim_prefixes() {
        // Drive verbatim prefix is removed so the frontend sees a native path.
        assert_eq!(
            display_path(Path::new(r"\\?\C:\proj\file.txt")),
            r"C:\proj\file.txt"
        );
        // UNC verbatim prefix collapses back to a `\\server\share` path.
        assert_eq!(
            display_path(Path::new(r"\\?\UNC\server\share\file.txt")),
            r"\\server\share\file.txt"
        );
    }
}

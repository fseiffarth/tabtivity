use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use tauri::State;

use crate::paths;
use crate::schema::project::{
    ComputeHost, DetectedSpecKind, DetectedSpecSource, OpenVpnSpec, Project, RemoteSpec,
    SandboxSourceDecision, SandboxSpec, SandboxToggleOutcome,
};
use crate::schema::projects::{ProjectEntry, ProjectsList};
use crate::services::remote_sync::SyncManifestState;
use crate::storage;

/// Local per-project state directory for a **remote** project:
/// `<state_dir>/remote-projects/<id>`. Mount-free remote projects keep their
/// `project.json` (tabs/time/etc.) here — a real local dir, unlike the old sshfs
/// mountpoint — while the project's tree lives on the host and is reached over
/// SFTP/SSH. This path becomes the project's `directory` (a stable local key the
/// fs/git/terminal commands resolve to a `RemoteTarget`).
pub(crate) fn remote_project_state_dir(id: &str) -> std::path::PathBuf {
    storage::state_dir().join("remote-projects").join(id)
}

/// Drop the per-project state that is bound to **one specific host**: the byte-sync
/// manifest (`sync.json`) and the lockstep state (`git_peer.json`). Both are meaningless
/// — worse, actively wrong — once a project is pointed at a *different* host, or at none.
///
/// The manifest is the dangerous one, and it is why detach→re-extend needs this at all.
/// Its entries carry `last_pull_ts`/`last_push_ts`, so against a fresh, empty host
/// `push_decision` sees `ever_synced = true` plus a missing file and returns `Stale` — it
/// **refuses to push**. Meanwhile `divergence` maps the failed host stat to "couldn't
/// check → don't flag", so the file tree paints the very same file **green**. Net: a
/// re-extended project whose auto-synced data silently never crosses, reported as fully
/// in sync. The classic false green.
///
/// The state dir is keyed by project **id**, which a detach preserves — so a re-extend
/// lands back on the same directory and inherits whatever the detach left behind.
/// `remove_dir` (as detach used to call) only removes an *empty* dir, and this one never
/// is, so every one of these files survived.
///
/// Evicting the in-memory cache is not optional: `ensure_loaded` is `or_insert_with`, so
/// a manifest already loaded this session is never re-read from disk — deleting the file
/// alone would just get the stale copy re-saved on the next pass.
///
/// `local_loss.json` deliberately **survives**: it records what was destroyed in the
/// *local mirror*, the user may not have acknowledged it yet, and it is a fact about this
/// machine rather than about any host.
async fn clear_host_bound_state(project_id: &str, manifest: &SyncManifestState) {
    let _ = fs::remove_file(crate::services::remote_sync::manifest_path(project_id));
    let _ = fs::remove_file(crate::services::git_peer::state_path(project_id));
    manifest.lock().await.remove(project_id);
}

/// Compute a `<name>` leaf under `parent` for a remote (SSH) project's local
/// mirror. `sanitize_name` keeps the folder readable; the `id` disambiguates a
/// name-based path already taken by another remote project, so two hosts' `~/work`
/// never collide on the same local mirror. Shared by the default location and the
/// user-chosen `mirror_parent`.
///
/// "Already taken" is two questions, not one: a directory that **exists** on disk,
/// and one another project has **registered** as its mirror. They are not the same
/// set — a user who deletes a mirror folder leaves its registration behind, and
/// existence alone would then hand the next remote project the very same path,
/// putting two projects' lockstep and byte-sync on one local tree. Checking the
/// registry too costs one list scan and closes that.
fn remote_mirror_in(parent: &Path, name: &str, id: &str, list: &ProjectsList) -> PathBuf {
    let safe = sanitize_name(name);
    let leaf = if safe.is_empty() {
        id.to_string()
    } else {
        safe
    };
    let candidate = parent.join(&leaf);
    let taken = candidate.exists()
        || find_project_conflict(
            list,
            &ProjectSite::Local {
                dir: &candidate.to_string_lossy(),
            },
            None,
        )
        .is_some();
    if taken {
        parent.join(format!("{leaf}-{}", &id[..id.len().min(8)]))
    } else {
        candidate
    }
}

/// The default local mirror location for a new remote (SSH) project: a readable
/// `<name>` subfolder of the top-level `tabtivity/projects-ssh/` root (rather than a
/// hidden state dir or the managed-local `projects/` tree).
fn default_remote_mirror(name: &str, id: &str, list: &ProjectsList) -> PathBuf {
    remote_mirror_in(&paths::projects_ssh_root(), name, id, list)
}

/// Resolve a remote project's local mirror path: under the user-chosen
/// `mirror_parent` (the dialog's "Local location") when provided and non-empty,
/// otherwise the default `projects-ssh` root. Returns the full `<parent>/<name>`
/// path as a string, ready to store in `project.json`/`projects.json`.
pub(crate) fn resolve_remote_mirror(
    mirror_parent: Option<&str>,
    name: &str,
    id: &str,
    list: &ProjectsList,
) -> String {
    match mirror_parent.map(str::trim).filter(|p| !p.is_empty()) {
        Some(parent) => remote_mirror_in(Path::new(parent), name, id, list),
        None => default_remote_mirror(name, id, list),
    }
    .to_string_lossy()
    .to_string()
}

// ── Duplicate registration ────────────────────────────────────────────────

/// What a project **occupies**, as the registry sees it — the identity no two
/// projects may share.
///
/// The two variants are not two spellings of one thing. A *local* project is its
/// directory. A *remote* project's `directory` is a per-id state dir holding only
/// `project.json`, so comparing that would never match anything, however many
/// times the same host folder is imported; its identity is the host login plus the
/// path on that host.
pub enum ProjectSite<'a> {
    Local { dir: &'a str },
    Remote { spec: &'a RemoteSpec },
}

/// The already-registered project a new one would collide with. `kind` is a
/// machine token (the frontend words it, in five languages — same split
/// `services::web_safety` uses for its refusal reasons).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConflict {
    pub id: String,
    pub name: String,
    /// `"directory"` — the same local folder is already a project.
    /// `"mirror"` — it is a remote project's local mirror (the working copy
    /// Tabtivity syncs), which is a tree that already has an owner.
    /// `"remote-path"` — the same login on the same host, at the same path.
    pub kind: String,
}

/// Resolve `.`/`..`/repeated separators without touching the filesystem — the
/// fallback for a path that does not exist yet, where `canonicalize` cannot help.
/// A leading `..` in a relative path survives (there is nothing to pop), and
/// `/..` stays `/`, matching what the kernel would do.
fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(out.components().next_back(), Some(Component::Normal(_))) {
                    out.pop();
                } else if out.has_root() {
                    // `/..` is `/`: nothing above the root to climb to.
                } else {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Canonical comparison key for a **local** project directory.
///
/// The registry is compared on this rather than on the raw string the dialog
/// happened to send, because `/a/foo`, `/a/foo/`, `/a/./foo` and a symlink into
/// that folder are one project, and a plain string compare reads them as four.
///
/// `canonicalize` is the real answer (it resolves symlinks against the actual
/// filesystem) but only works on a path that exists — a copy/move import's
/// destination does not yet — so the fallback canonicalizes the deepest
/// existing ancestor of the `lexical_normalize`d path and re-appends the rest;
/// otherwise a missing folder under a symlinked or 8.3-short-named parent
/// (macOS `/var`, Windows `RUNNER~1`) would never prefix-match its existing
/// siblings. The `\\?\` verbatim prefix is stripped so the halves produce
/// comparable keys on Windows, where the comparison is also case-insensitive.
fn local_dir_key(dir: &str) -> String {
    let trimmed = dir.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let path = PathBuf::from(trimmed);
    let resolved = fs::canonicalize(&path).unwrap_or_else(|_| {
        let normal = lexical_normalize(&path);
        normal
            .ancestors()
            .skip(1)
            .find_map(|base| {
                let real = fs::canonicalize(base).ok()?;
                Some(real.join(normal.strip_prefix(base).ok()?))
            })
            .unwrap_or(normal)
    });
    let key = resolved.to_string_lossy().to_string();
    let key = key.strip_prefix(r"\\?\").unwrap_or(&key).to_string();
    if cfg!(windows) {
        key.to_lowercase()
    } else {
        key
    }
}

/// Canonical `user@host:port` for a remote spec — the backend twin of the
/// frontend's `machineSync.sameTarget` (host case-insensitive, default port 22,
/// an empty user equivalent to none). A *different login* on the same host stays
/// a different target on purpose: it is a different connection, reaching a
/// different home directory with different rights.
fn ssh_target_key(spec: &RemoteSpec) -> String {
    let user = spec
        .user
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty())
        .unwrap_or("");
    format!(
        "{user}@{}:{}",
        spec.host.trim().to_lowercase(),
        spec.port.unwrap_or(22)
    )
}

/// Canonical comparison form of a path **on a host**: POSIX, so collapse repeated
/// separators and drop the trailing one (keeping `/` itself).
///
/// Deliberately does not expand `~` or resolve `..`: only the host knows what
/// they resolve to, and guessing here would either merge two different folders or
/// split one. `~/work` and `/home/alice/work` are therefore compared as the two
/// different strings they are — reachable only by typing the path, since browsing
/// to a folder always yields an absolute one.
fn remote_path_key(path: &str) -> String {
    let trimmed = path.trim();
    let body = trimmed
        .split('/')
        .filter(|seg| !seg.is_empty() && *seg != ".")
        .collect::<Vec<_>>()
        .join("/");
    let key = if trimmed.starts_with('/') {
        format!("/{body}")
    } else {
        body
    };
    if key.is_empty() {
        trimmed.to_string()
    } else {
        key
    }
}

fn remote_site_key(spec: &RemoteSpec) -> String {
    format!(
        "{}|{}",
        ssh_target_key(spec),
        remote_path_key(&spec.remote_path)
    )
}

fn entry_remote_spec(entry: &ProjectEntry) -> Option<RemoteSpec> {
    entry
        .extra
        .get("remote")
        .and_then(|v| serde_json::from_value::<RemoteSpec>(v.clone()).ok())
}

/// The already-registered project `site` would collide with, if any.
///
/// This is the **whole** duplicate gate, in one pure function, so `create_project`,
/// `import_project`, `finish_import` and `extend_project_to_remote` cannot drift
/// into four different ideas of what "already imported" means — which is how the
/// gate came to cover local keep-imports and nothing else. `skip_id` excludes the
/// project being re-pointed (extend edits one that is already in the list).
pub(crate) fn find_project_conflict(
    list: &ProjectsList,
    site: &ProjectSite,
    skip_id: Option<&str>,
) -> Option<ProjectConflict> {
    let entries = list.iter().filter(|p| skip_id != Some(p.id.as_str()));
    match site {
        ProjectSite::Local { dir } => {
            let key = local_dir_key(dir);
            if key.is_empty() {
                return None;
            }
            for entry in entries {
                // A remote project's `directory` is its state dir — never a folder
                // the user can browse to — but its `mirror` is a real local tree
                // that lockstep and byte-sync already own, so importing *that* as
                // its own project is the same collision wearing a different hat.
                let kind = if entry_directory(entry).map(|d| local_dir_key(&d)).as_deref()
                    == Some(key.as_str())
                {
                    "directory"
                } else if entry_mirror(entry).map(|m| local_dir_key(&m)).as_deref()
                    == Some(key.as_str())
                {
                    "mirror"
                } else {
                    continue;
                };
                return Some(ProjectConflict {
                    id: entry.id.clone(),
                    name: entry.name.clone(),
                    kind: kind.to_string(),
                });
            }
            None
        }
        ProjectSite::Remote { spec } => {
            let key = remote_site_key(spec);
            entries
                .filter(|entry| {
                    entry_remote_spec(entry)
                        .map(|s| remote_site_key(&s))
                        .as_deref()
                        == Some(key.as_str())
                })
                .map(|entry| ProjectConflict {
                    id: entry.id.clone(),
                    name: entry.name.clone(),
                    kind: "remote-path".to_string(),
                })
                .next()
        }
    }
}

/// The refusal a command returns. Only ever reached when the dialog's pre-check
/// (`check_project_site`) was skipped or read a stale list, so it is plain English
/// like every other backend error here — the *worded*, translated version is the
/// frontend's, off `ProjectConflict.kind`.
pub(crate) fn conflict_message(conflict: &ProjectConflict) -> String {
    match conflict.kind.as_str() {
        "remote-path" => format!(
            "That folder on the host is already the project '{}'",
            conflict.name
        ),
        "mirror" => format!(
            "That folder is the local mirror of the remote project '{}'",
            conflict.name
        ),
        _ => format!("That folder is already the project '{}'", conflict.name),
    }
}

pub(crate) fn read_projects_list() -> Result<ProjectsList, String> {
    let path = storage::state_dir().join("projects.json");
    if path.exists() {
        storage::read_json(&path).map_err(|e| e.to_string())
    } else {
        Ok(vec![])
    }
}

/// Apply one serialized read-modify-write to the project registry. Existing
/// corrupt JSON is an error, never an empty registry, and every successful
/// mutation lands through an atomic replacement.
pub(crate) fn patch_projects_list<R>(
    patch: impl FnOnce(&mut ProjectsList) -> Result<R, String>,
) -> Result<R, String> {
    let path = storage::state_dir().join("projects.json");
    storage::patch_json(&path, ProjectsList::new(), |list| {
        // The built-in Trash workspace was removed; every registry read or
        // write drops its leftover entry (its folder stays on disk).
        drop_legacy_trash_project(list);
        patch(list)
    })
}

/// Patch one registry entry without open-coding another whole-list
/// read-modify-write. The closure's return value can carry the entry's
/// `local_file` into the best-effort `project.json` mirror update.
pub(crate) fn patch_project_entry<R>(
    project_id: &str,
    patch: impl FnOnce(&mut ProjectEntry) -> Result<R, String>,
) -> Result<R, String> {
    patch_projects_list(|list| {
        let entry = list
            .iter_mut()
            .find(|entry| entry.id == project_id)
            .ok_or_else(|| format!("project '{project_id}' not found"))?;
        patch(entry)
    })
}

/// The side panel's per-project view settings. They live on the trusted
/// `projects.json` entry: the in-folder `project.json` copy is writable by
/// anything working in the tree, and a list read from there could hide files
/// from the tree or from scans. `project.json` keeps a display/export mirror.
pub const PANEL_PREF_KEYS: &[&str] = &[
    "panel_hidden_endings",
    "panel_hidden_paths",
    "panel_shown_paths",
    "scan_excluded_paths",
    "panel_separate_scaffold",
    "panel_separate_gitignored",
];

/// The id of the registry entry whose `project.json` is `local_file` — the key
/// the side panel's filter hook holds.
fn project_id_for_local_file(local_file: &str) -> Result<String, String> {
    read_projects_list()?
        .into_iter()
        .find(|e| e.local_file == local_file)
        .map(|e| e.id)
        .ok_or_else(|| format!("no project is registered for '{local_file}'"))
}

/// The panel settings, from the trusted entry (see [`PANEL_PREF_KEYS`]).
#[tauri::command]
pub fn get_project_panel_prefs(local_file: String) -> Result<serde_json::Map<String, Value>, String> {
    let list = read_projects_list()?;
    let entry = list
        .iter()
        .find(|e| e.local_file == local_file)
        .ok_or_else(|| format!("no project is registered for '{local_file}'"))?;
    Ok(PANEL_PREF_KEYS
        .iter()
        .filter_map(|k| entry.extra.get(*k).map(|v| ((*k).to_string(), v.clone())))
        .collect())
}

/// Set (or, with `null`, clear) panel settings on the trusted entry and its
/// mirror. Keys outside [`PANEL_PREF_KEYS`] are ignored.
#[tauri::command]
pub fn set_project_panel_prefs(
    local_file: String,
    prefs: serde_json::Map<String, Value>,
) -> Result<(), String> {
    let project_id = project_id_for_local_file(&local_file)?;
    let prefs: Vec<(String, Value)> = prefs
        .into_iter()
        .filter(|(k, _)| PANEL_PREF_KEYS.contains(&k.as_str()))
        .collect();
    let apply = |extra: &mut HashMap<String, Value>| {
        for (k, v) in &prefs {
            if v.is_null() {
                extra.remove(k);
            } else {
                extra.insert(k.clone(), v.clone());
            }
        }
    };
    patch_project_entry_mirrored(
        &project_id,
        |entry| {
            apply(&mut entry.extra);
            Ok(())
        },
        |project, ()| apply(&mut project.extra),
    )
}

/// One-shot copy of the panel settings from each project's `project.json` into
/// its `projects.json` entry, for projects registered before the settings moved.
/// Once per installation (like `migrate_project_sessions_once`): a project
/// registered afterwards is never read from its folder.
pub fn migrate_panel_prefs_once() {
    let marker = storage::state_dir().join(".panel_prefs_migrated");
    if marker.exists() {
        return;
    }
    let result = patch_projects_list(|list| {
        for entry in list.iter_mut() {
            let Ok(project) = storage::read_json::<Value>(Path::new(&entry.local_file)) else {
                continue;
            };
            for key in PANEL_PREF_KEYS {
                if let Some(v) = project.get(*key).filter(|v| !v.is_null()) {
                    entry.extra.entry((*key).to_string()).or_insert_with(|| v.clone());
                }
            }
        }
        Ok(())
    });
    match result {
        Ok(()) => {
            let _ = std::fs::write(&marker, b"");
        }
        Err(e) => eprintln!("migrate_panel_prefs_once: {e}"),
    }
}

/// [`patch_project_entry`] plus the mirror write every per-field setter used to
/// open-code: after the registry patch lands, apply `patch_project` to the
/// entry's own `project.json` and write it back atomically. The mirror closure
/// receives the registry patch's result, so a value computed under the registry
/// lock (e.g. the merged host list) can be mirrored without a second read. A
/// missing `project.json` is fine — the registry is the source of truth and the
/// file is display/export data (a remote project's copy may simply not exist
/// locally). An *existing* file that fails to parse is an error, not a silent
/// skip: the registry write has already landed by then, so skipping quietly is
/// exactly how the two copies diverge with no signal.
pub(crate) fn patch_project_entry_mirrored<R>(
    project_id: &str,
    patch_entry: impl FnOnce(&mut ProjectEntry) -> Result<R, String>,
    patch_project: impl FnOnce(&mut Project, &R),
) -> Result<R, String> {
    let (result, local_file) = patch_project_entry(project_id, |entry| {
        let result = patch_entry(entry)?;
        Ok((result, entry.local_file.clone()))
    })?;
    let proj_path = PathBuf::from(&local_file);
    if proj_path.exists() {
        let mut project: Project = storage::read_json(&proj_path).map_err(|e| {
            format!(
                "the registry was updated, but the project's own project.json \
                 could not be read to mirror the change (it is now stale): {e}"
            )
        })?;
        patch_project(&mut project, &result);
        storage::write_json_atomic(&proj_path, &project).map_err(|e| e.to_string())?;
    }
    Ok(result)
}

/// Remove the entry of the retired built-in Trash workspace (`tabtivity-trash`),
/// which older Tabtivity versions created and kept pinned. Its `~/tabtivity/trash`
/// folder is left untouched.
fn drop_legacy_trash_project(list: &mut ProjectsList) {
    list.retain(|p| p.id != paths::LEGACY_TRASH_PROJECT_ID);
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckProjectSiteRequest {
    /// The local folder a new/imported project would occupy. Ignored when
    /// `remote` is present (a remote project's identity is its host path).
    #[serde(default)]
    pub directory: Option<String>,
    #[serde(default)]
    pub remote: Option<RemoteSpec>,
    /// The project being re-pointed (extend-to-remote), excluded from the scan.
    #[serde(default)]
    pub skip_id: Option<String>,
}

/// Ask, without creating anything, whether a folder or host path is already a
/// project — so the dialog can say so **before** the user fills the rest of the
/// form and before a clone downloads a whole repository that will be refused.
///
/// Advisory only: the commands that write re-run the same check against the list
/// on disk, since this answer can be stale by the time Create is clicked.
#[tauri::command]
pub fn check_project_site(req: CheckProjectSiteRequest) -> Result<Option<ProjectConflict>, String> {
    let list = read_projects_list()?;
    let site = match req.remote.as_ref() {
        Some(spec) => ProjectSite::Remote { spec },
        None => match req.directory.as_deref() {
            Some(dir) => ProjectSite::Local { dir },
            None => return Ok(None),
        },
    };
    Ok(find_project_conflict(&list, &site, req.skip_id.as_deref()))
}

/// Whether anything — a folder, a file, a symlink (dangling or not) — already
/// sits at `directory`. The New-project dialog asks before Create so it can say
/// the project can't be made there; advisory, like `check_project_site` —
/// `create_project`'s own `claim_new_project_dir` is the gate.
#[tauri::command]
pub fn project_folder_exists(directory: String) -> bool {
    !directory.trim().is_empty() && fs::symlink_metadata(&directory).is_ok()
}

/// Create a **new** local project's folder, refusing one that already exists.
///
/// A new project starts in a folder of its own. One that is already there holds
/// somebody's files — a project that was never registered, a backup, another
/// app's data — and creating over it would scaffold into it, `git init` it, and
/// replace any `project.json` it carries. Importing is the verb for an existing
/// folder. `create_dir` (not `_all`) on the leaf makes the check and the claim
/// one step, so a folder appearing between the dialog's check and this call is
/// refused too.
fn claim_new_project_dir(dir: &Path) -> Result<(), String> {
    if dir.as_os_str().is_empty() {
        return Err("No folder was given for the new project".to_string());
    }
    if let Some(parent) = dir.parent().filter(|p| !p.as_os_str().is_empty()) {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::create_dir(dir).map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => format!(
            "The folder {} already exists, so the project cannot be created there. \
             Choose another name, or import the folder instead.",
            dir.display()
        ),
        _ => e.to_string(),
    })
}

// ── Project list ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_projects() -> Result<ProjectsList, String> {
    patch_projects_list(|list| {
        for entry in list.iter_mut() {
            normalize_entry(entry);
        }
        Ok(list.clone())
    })
}

/// Bring one `projects.json` entry up to the current on-disk shape, in place.
///
/// Old Tabtivity versions (pre-Group-D) wrote entries that omit fields the current
/// code and pill/hover UI expect. This backfills those from information the
/// entry already carries, so a legacy project (e.g. the self-hosting
/// checkout's own entry, which predates persisted `directory`) becomes
/// indistinguishable from a freshly-created one. Purely additive/canonicalizing:
/// it never overwrites a value the entry already sets.
///
/// - `directory`: derived from `local_file`'s parent (always `<dir>/project.json`)
///   when absent. Load-bearing — provider sniffing, archive, and remoteness
///   checks all key off it.
/// - `git_type`: legacy `private`/`public` mapped to the `remote-*` model.
///
/// Returns `true` when it actually changed something — i.e. the entry was
/// legacy. Startup uses that as the trigger to also refresh the project's
/// on-disk scaffold (see `migrate_legacy_projects`).
pub(crate) fn normalize_entry(entry: &mut ProjectEntry) -> bool {
    let mut changed = false;
    // Backfill a missing working directory from `local_file`'s parent.
    let has_dir = matches!(entry.extra.get("directory"), Some(Value::String(d)) if !d.is_empty());
    if !has_dir {
        if let Some(parent) = std::path::Path::new(&entry.local_file).parent() {
            if !parent.as_os_str().is_empty() {
                entry.extra.insert(
                    "directory".to_string(),
                    Value::String(parent.to_string_lossy().into_owned()),
                );
                changed = true;
            }
        }
    }
    // Canonicalize a legacy git_type value (private/public → remote-*).
    if let Some(Value::String(gt)) = entry.extra.get("git_type") {
        let norm = normalize_git_type(gt);
        if &norm != gt {
            entry
                .extra
                .insert("git_type".to_string(), Value::String(norm));
            changed = true;
        }
    }
    changed
}

/// The hosting provider recorded alongside a `remote-*` `git_type`, from the
/// dialog's clone/fork URL. Only the two providers Tabtivity speaks to are kept,
/// and only for a project that actually has a hosting target — a `local` or
/// `none` project naming a provider would badge a repo that is pushed nowhere.
pub(crate) fn normalize_git_provider(value: Option<&str>, git_type: &str) -> Option<String> {
    if !git_type.starts_with("remote-") {
        return None;
    }
    match value.unwrap_or("").trim().to_ascii_lowercase().as_str() {
        "github" => Some("github".to_string()),
        "gitlab" => Some("gitlab".to_string()),
        _ => None,
    }
}

/// Normalize a `git_type` value to the local/remote model used since Group D.
/// Legacy values map private → remote-private, public → remote-public; the
/// canonical values pass through; anything unrecognized falls back to "local".
pub(crate) fn normalize_git_type(value: &str) -> String {
    match value.trim() {
        "private" => "remote-private",
        "public" => "remote-public",
        "local" => "local",
        "none" => "none",
        "remote-private" => "remote-private",
        "remote-public" => "remote-public",
        _ => "local",
    }
    .to_string()
}

#[tauri::command]
pub fn save_projects(projects: ProjectsList) -> Result<(), String> {
    patch_projects_list(|current| {
        // The frontend uses this command for pill status/order only. Treating
        // its cached whole-list snapshot as authoritative would let it erase a
        // VM/HPC/background update that landed after the snapshot was loaded.
        for incoming in projects {
            if let Some(stored) = current.iter_mut().find(|entry| entry.id == incoming.id) {
                stored.status = incoming.status;
                stored.position = incoming.position;
                // One deliberate legacy cleanup still rides the next ordinary
                // save: box membership moved to boxes.json and this flattened
                // key must disappear once the frontend has stripped it.
                if !incoming.extra.contains_key("box_id") {
                    stored.extra.remove("box_id");
                }
            }
        }
        Ok(())
    })
}

// ── Archive (delete → restorable holding area) ─────────────────────────────
//
// Deleting a project moves its LOCAL folders into `~/tabtivity/archive/<id>/` and
// drops it from `projects.json`. A remote project's tree on its host is never
// touched — only its local state dir + mirror move. The archive is only cleared
// manually from Settings; restore moves the folders back and re-registers the
// project as `inactive`.

/// Restore manifest written into `archive/<id>/entry.json`. Holds the full
/// original `projects.json` entry (the source of truth for restore) plus the
/// archive stamp and a remote flag.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ArchiveManifest {
    entry: ProjectEntry,
    archived_at: String,
    remote: bool,
}

/// A summary row for the Settings "Archived projects" list.
#[derive(Debug, Clone, Serialize)]
pub struct ArchivedProject {
    pub id: String,
    pub name: String,
    pub archived_at: String,
    pub remote: bool,
}

/// Reject ids that could escape the archive root (path traversal). Project ids
/// are UUIDs in practice, so anything with a separator or `..` is invalid.
pub(crate) fn validate_project_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err(format!("invalid project id '{id}'"));
    }
    Ok(())
}

pub(crate) fn entry_directory(entry: &ProjectEntry) -> Option<String> {
    entry
        .extra
        .get("directory")
        .and_then(Value::as_str)
        .map(str::to_string)
}

pub(crate) fn entry_mirror(entry: &ProjectEntry) -> Option<String> {
    entry
        .extra
        .get("mirror")
        .and_then(Value::as_str)
        .map(str::to_string)
}

pub(crate) fn entry_is_remote(entry: &ProjectEntry) -> bool {
    entry
        .extra
        .get("remote")
        .map(|v| !v.is_null())
        .unwrap_or(false)
}

pub(crate) fn entry_is_vm(entry: &ProjectEntry) -> bool {
    entry.extra.get("vm").is_some_and(|v| !v.is_null())
}

/// Move a directory tree from `src` to `dst`, creating `dst`'s parent. Tries a
/// fast `rename` first and falls back to recursive copy + remove in exactly two
/// cases: a cross-filesystem move, and a `dst` that already exists. The second is
/// deliberate — `archive_project` resumes an interrupted archive *into* the
/// partial destination it left, and `rename` onto a non-empty directory fails
/// with `ENOTEMPTY` (Linux) or its per-OS twin, not with a cross-device error.
/// Any other rename failure (a file held open, a permission refusal) is returned
/// as it is rather than papered over with a copy. No-op when `src` does not
/// exist. `src` is only removed after the whole copy succeeded, so a failed
/// fallback leaves the source intact and the move retryable.
fn move_tree(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.exists() {
        return Ok(());
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    match fs::rename(src, dst) {
        Ok(()) => return Ok(()),
        Err(e) if crate::paths::is_cross_device(&e) || dst.exists() => {}
        Err(e) => return Err(format!("could not move {}: {e}", src.display())),
    }
    copy_tree_core(src, dst, true)?;
    fs::remove_dir_all(src).map_err(|e| e.to_string())?;
    Ok(())
}

/// The ONE recursive tree-copy core behind both copiers ([`move_tree`]'s
/// cross-device fallback and [`copy_dir_all`]).
///
/// `keep_git` says whose copy this is: an archive/restore/mirror **move**
/// carries `.git` verbatim — the tree *is* the project, history included —
/// while the duplicate/import path leaves git's administrative state behind
/// (and skips any directory holding a `.git` of either kind, see
/// [`copy_dir_all`]'s doc for why the *file* form matters).
///
/// Symlinks are **recreated as links, never followed**. Following them
/// (`fs::copy` on the link path, as both copiers used to) has two failure
/// modes: a *dangling* link — a stale venv/node `bin` pointer is the ordinary
/// case — errored out a cross-device `archive_project` halfway through the
/// move, and a link to a large tree silently duplicated it. A dangling link is
/// therefore fine here: the link itself is copied, pointing at the same target.
fn copy_tree_core(src: &Path, dst: &Path, keep_git: bool) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if !keep_git && entry.file_name() == ".git" {
            continue;
        }
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if file_type.is_symlink() {
            copy_symlink(&from, &to)?;
        } else if file_type.is_dir() {
            if !keep_git && fs::symlink_metadata(from.join(".git")).is_ok() {
                continue;
            }
            copy_tree_core(&from, &to, keep_git)?;
        } else {
            fs::copy(&from, &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Recreate one symlink at `to`, replacing whatever an interrupted earlier copy
/// may have left there (that is what makes a resumed `archive_project` pass
/// idempotent). On Windows creating a symlink needs a privilege most users
/// lack, so a refused link degrades to copying what it resolves to — and a
/// dangling one is skipped, since it pointed at nothing to lose.
fn copy_symlink(from: &Path, to: &Path) -> Result<(), String> {
    let target = fs::read_link(from).map_err(|e| e.to_string())?;
    if fs::symlink_metadata(to).is_ok() {
        let _ = fs::remove_file(to);
    }
    #[cfg(unix)]
    return std::os::unix::fs::symlink(&target, to).map_err(|e| e.to_string());
    #[cfg(windows)]
    {
        let is_dir = fs::metadata(from).map(|m| m.is_dir()).unwrap_or(false);
        let made = if is_dir {
            std::os::windows::fs::symlink_dir(&target, to)
        } else {
            std::os::windows::fs::symlink_file(&target, to)
        };
        if made.is_err() {
            if let Ok(meta) = fs::metadata(from) {
                if meta.is_file() {
                    fs::copy(from, to).map_err(|e| e.to_string())?;
                }
            }
        }
        Ok(())
    }
}

/// The original path if free, else a collision-safe sibling, so restoring never
/// clobbers a folder re-created since the project was archived.
fn free_target(orig: &Path) -> PathBuf {
    if !orig.exists() {
        return orig.to_path_buf();
    }
    let parent = orig.parent().unwrap_or_else(|| Path::new("."));
    let stem = orig
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("restored");
    for n in 1..1000 {
        let cand = parent.join(format!("{stem}-restored-{n}"));
        if !cand.exists() {
            return cand;
        }
    }
    parent.join(format!("{stem}-restored"))
}

/// Purge a project's time-tracking history: drop it from every day bucket of the
/// rolling summary and filter it out of the legacy append-only log if present.
/// Called only on PERMANENT deletion (archiving keeps the history).
fn purge_project_time(project_id: &str) -> Result<(), String> {
    use crate::schema::time_log;
    time_log::patch_summary(|summary| {
        for by_project in summary.days.values_mut() {
            by_project.remove(project_id);
        }
        Ok(())
    })?;
    let legacy = storage::state_dir().join(time_log::LEGACY_LOG_FILE);
    if legacy.exists() {
        let entries =
            storage::read_json::<time_log::TimeLog>(&legacy).map_err(|e| e.to_string())?;
        let kept: time_log::TimeLog = entries
            .into_iter()
            .filter(|e| e.project_id != project_id)
            .collect();
        storage::write_json_atomic(&legacy, &kept).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Offload a blocking project-lifecycle body to a worker thread. Archiving,
/// restoring, moving a mirror, creating and importing all move whole trees
/// (and `archive_project` shuts a VM down inline — seconds); run synchronously
/// on the main thread that froze the window — the freeze class
/// `commands::git`'s `run_off_thread` doc describes. The sync `*_blocking`
/// bodies stay directly unit-testable (see `tests/projects_commands.rs`).
async fn run_off_thread<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("project task failed: {e}"))?
}

/// Move a project into the archive and drop it from `projects.json`. `archived_at`
/// is a caller-supplied ISO timestamp (the frontend stamps it). The remote host
/// tree is never touched — only local folders move.
#[tauri::command]
pub async fn archive_project(project_id: String, archived_at: String) -> Result<(), String> {
    run_off_thread(move || archive_project_blocking(project_id, archived_at)).await
}

pub fn archive_project_blocking(project_id: String, archived_at: String) -> Result<(), String> {
    validate_project_id(&project_id)?;

    let list = read_projects_list()?;
    let idx = list
        .iter()
        .position(|p| p.id == project_id)
        .ok_or_else(|| format!("project '{project_id}' not found"))?;
    let entry = list[idx].clone();
    let remote = entry_is_remote(&entry);

    let dest = paths::archive_root().join(&project_id);
    // The manifest is written LAST, so its presence is what "already archived"
    // means. A dest without one is a previous attempt that failed partway
    // (e.g. a cross-device move erroring mid-copy): resume into it — move_tree
    // no-ops for trees already moved and re-copies over any partial copy —
    // rather than refusing with no path forward (the project is still
    // registered, its folders half here, and retry used to be blocked).
    if dest.join("entry.json").exists() {
        return Err(format!(
            "an archived project with id '{project_id}' already exists"
        ));
    }
    fs::create_dir_all(&dest).map_err(|e| e.to_string())?;

    // Move the LOCAL folders. Remote host tree is intentionally left in place.
    if remote {
        move_tree(&remote_project_state_dir(&project_id), &dest.join("state"))?;
        if let Some(mirror) = entry_mirror(&entry) {
            move_tree(Path::new(&mirror), &dest.join("mirror"))?;
        }
        // A VM project's "host tree" is its overlay disk in the local VM state
        // dir — for a mirrorless VM project that overlay IS the working tree,
        // so it archives with the project (and deletes with the archive; the
        // confirm dialog names that). Shut the VM down first.
        let vm_state = crate::services::vm::vm_dir(&project_id);
        if vm_state.exists() {
            crate::services::vm::shutdown(&project_id);
            move_tree(&vm_state, &dest.join("vm"))?;
        }
    } else if let Some(dir) = entry_directory(&entry) {
        move_tree(Path::new(&dir), &dest.join("dir"))?;
    }

    let manifest = ArchiveManifest {
        entry,
        archived_at,
        remote,
    };
    storage::write_json(&dest.join("entry.json"), &manifest).map_err(|e| e.to_string())?;

    patch_projects_list(|list| {
        let before = list.len();
        list.retain(|project| project.id != project_id);
        if list.len() == before {
            return Err(format!("project '{project_id}' not found"));
        }
        Ok(())
    })?;
    Ok(())
}

/// Remove a project from Tabtivity and leave its folder exactly where it is.
///
/// The counterpart of `archive_project` for when the *files* are fine and only
/// Tabtivity's view of them is wrong — an import that went sideways, a folder
/// registered under the wrong name, a tree that should be imported again from
/// scratch. Nothing inside the project folder is touched: not `project.json`,
/// not the scaffold (`PROJECT.md`, `AGENTS.md`, `.claude/settings.json`,
/// `.gitignore` — the scaffold only writes those when absent, so any of them may
/// be the user's own), not `.tabtivity/`, and certainly nothing the user put there
/// themselves (a `README.md`). A remote project's mirror is user files
/// and stays too. What goes is Tabtivity's own state *about* the project, all of it
/// keyed by the id and all of it outside the tree: the `projects.json` entry,
/// `<state_dir>/sessions/<id>/` (tab layout, `open_apps`, host-bound markers),
/// `<state_dir>/live_sessions/<id>/` (agent resume records), the time-tracking
/// history, and for a remote project the local per-project state dir (which
/// holds only its `project.json`). A later re-import gets a fresh id, so none of
/// that would ever be read again — and the duplicate gate it has to pass looks
/// at the registry, not the folder.
///
/// A VM project is refused: its overlay disk lives in Tabtivity's state dir and
/// *is* the working tree, so "keep the files" has nothing to keep — that one
/// goes through the archive, which moves the disk with it.
#[tauri::command]
pub async fn forget_project(project_id: String) -> Result<(), String> {
    run_off_thread(move || forget_project_blocking(project_id)).await
}

pub fn forget_project_blocking(project_id: String) -> Result<(), String> {
    validate_project_id(&project_id)?;
    let list = read_projects_list()?;
    let entry = list
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| format!("project '{project_id}' not found"))?
        .clone();
    if entry_is_vm(&entry) {
        return Err(concat!("A VM project's disk lives in ", crate::app_name!(), "'s state, so there is no folder to \
                    keep — use \"Delete project…\", which archives the disk with it.")
            .into());
    }
    let remote = entry_is_remote(&entry);

    // Unregister FIRST. Once the entry is gone the project can no longer be
    // activated, so a purge failing partway leaves at worst an orphaned state
    // dir (inert: nothing reads it without a registry entry) — never a
    // registered project with half its state missing.
    patch_projects_list(|list| {
        let before = list.len();
        list.retain(|project| project.id != project_id);
        if list.len() == before {
            return Err(format!("project '{project_id}' not found"));
        }
        Ok(())
    })?;

    forget_project_state(&project_id, remote)
}

/// The state-dir half of `forget_project`: every directory Tabtivity keeps *about*
/// a project, keyed by its id — all under the state dir, never under the tree.
fn forget_project_state(project_id: &str, remote: bool) -> Result<(), String> {
    let mut dirs = vec![
        storage::project_session_dir(project_id),
        crate::services::agent_session::project_live_sessions_dir(project_id),
        // The project's Tabtivity-owned agent home: its agents' config,
        // transcripts and session stores go with it (`services::agent_home`).
        crate::services::agent_home::scope_home(Some(project_id)),
    ];
    if remote {
        dirs.push(remote_project_state_dir(project_id));
    }
    remove_dirs_if_present(&dirs)?;
    purge_project_time(project_id)
}

/// Remove each directory that exists; one that isn't there is not an error
/// (a project that never opened a tab has no session dir). The first failure
/// stops the sweep and is reported with its path.
fn remove_dirs_if_present(dirs: &[PathBuf]) -> Result<(), String> {
    for dir in dirs {
        if dir.exists() {
            fs::remove_dir_all(dir)
                .map_err(|e| format!("could not remove '{}': {e}", dir.display()))?;
        }
    }
    Ok(())
}

/// List archived projects (newest first) for the Settings panel.
#[tauri::command]
pub fn list_archived_projects() -> Result<Vec<ArchivedProject>, String> {
    let root = paths::archive_root();
    if !root.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        if let Ok(m) = storage::read_json::<ArchiveManifest>(&entry.path().join("entry.json")) {
            out.push(ArchivedProject {
                id: m.entry.id.clone(),
                name: m.entry.name.clone(),
                archived_at: m.archived_at,
                remote: m.remote,
            });
        }
    }
    // Newest first; the stamp is an ISO string so a lexical sort is chronological.
    out.sort_by(|a, b| b.archived_at.cmp(&a.archived_at));
    Ok(out)
}

/// Restore an archived project: move its folders back (collision-safe) and
/// re-register it in `projects.json` as `inactive`. Returns the restored entry.
#[tauri::command]
pub async fn restore_archived_project(project_id: String) -> Result<ProjectEntry, String> {
    run_off_thread(move || restore_archived_project_blocking(project_id)).await
}

pub fn restore_archived_project_blocking(project_id: String) -> Result<ProjectEntry, String> {
    validate_project_id(&project_id)?;
    // Validate the registry before moving anything out of the archive. A
    // corrupt existing file must fail closed without leaving a half-restored
    // project tree behind.
    let _ = read_projects_list()?;

    let dest = paths::archive_root().join(&project_id);
    let manifest: ArchiveManifest =
        storage::read_json(&dest.join("entry.json")).map_err(|e| e.to_string())?;
    let mut entry = manifest.entry;

    if manifest.remote {
        // The state dir is keyed by id and was moved out on archive, so its
        // original path is free again.
        let state_dst = remote_project_state_dir(&project_id);
        move_tree(&dest.join("state"), &state_dst)?;
        entry.local_file = state_dst.join("project.json").to_string_lossy().to_string();
        entry.extra.insert(
            "directory".to_string(),
            Value::String(state_dst.to_string_lossy().to_string()),
        );
        let mirror_src = dest.join("mirror");
        if mirror_src.exists() {
            if let Some(orig) = entry_mirror(&entry) {
                let target = free_target(Path::new(&orig));
                move_tree(&mirror_src, &target)?;
                entry.extra.insert(
                    "mirror".to_string(),
                    Value::String(target.to_string_lossy().to_string()),
                );
            }
        }
        // A VM project's overlay/state dir moves back where the boot expects
        // it (keyed by id, so the original path is free again).
        let vm_src = dest.join("vm");
        if vm_src.exists() {
            move_tree(&vm_src, &crate::services::vm::vm_dir(&project_id))?;
        }
    } else if let Some(dir) = entry_directory(&entry) {
        let target = free_target(Path::new(&dir));
        move_tree(&dest.join("dir"), &target)?;
        entry.extra.insert(
            "directory".to_string(),
            Value::String(target.to_string_lossy().to_string()),
        );
        entry.local_file = target.join("project.json").to_string_lossy().to_string();
    }

    entry.status = "inactive".to_string();

    entry = patch_projects_list(|list| {
        entry.position = next_position(list);
        list.retain(|p| p.id != entry.id); // guard against a stale duplicate
        list.push(entry.clone());
        Ok(entry.clone())
    })?;

    fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
    Ok(entry)
}

/// One local branch of an archived mirror carrying commits the host baseline
/// does not contain.
#[derive(Debug, Clone, Serialize)]
pub struct UnsyncedBranch {
    pub name: String,
    pub count: usize,
}

/// Whether permanently deleting an archived remote project's mirror would discard
/// local-only history. Computed purely from the archived files — no host contact,
/// so it works while the host is offline.
#[derive(Debug, Clone, Serialize)]
pub struct UnsyncedReport {
    /// Total commits reachable from the mirror's local branches but not from the
    /// host baseline (last-synced tips). 0 means nothing would be lost.
    pub total: usize,
    /// Per-branch breakdown (only branches with a non-zero count).
    pub branches: Vec<UnsyncedBranch>,
    /// True when a host baseline existed to compare against (a recorded
    /// `remote_head` or any `refs/tabtivity/{incoming,backup}` ref). When false the
    /// count is every local commit and should be framed as "could not verify".
    pub verified: bool,
}

/// Run `git <args>` in `dir`, returning trimmed stdout (empty string on failure).
fn git_in(dir: &Path, args: &[&str]) -> String {
    crate::paths::command_no_window("git")
        .args(args)
        .current_dir(dir)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

/// Inspect an archived remote project's mirror for commits that were never synced
/// to its host, so the UI can warn before an irreversible permanent delete.
/// Non-remote projects (and those without a mirror repo) report nothing to lose.
// `(async)` on a sync fn: tauri runs the body on its blocking pool rather than
// the main thread. It forks 3 + one `rev-list --count` per branch against the
// mirror, which as a plain command stalled the window while the archive list's
// delete warning loaded. Read-only and self-contained (no State/AppHandle), so
// nothing depends on it running on the main thread; the body is unchanged.
#[tauri::command(async)]
pub fn archived_mirror_unsynced(project_id: String) -> Result<UnsyncedReport, String> {
    validate_project_id(&project_id)?;
    let none = UnsyncedReport {
        total: 0,
        branches: vec![],
        verified: true,
    };

    let dest = paths::archive_root().join(&project_id);
    let manifest: ArchiveManifest = match storage::read_json(&dest.join("entry.json")) {
        Ok(m) => m,
        Err(_) => return Ok(none),
    };
    // Only remote projects keep a paired mirror; local projects hold no host-only
    // relationship, so there is nothing that "wasn't synced".
    if !manifest.remote {
        return Ok(none);
    }
    let mirror = dest.join("mirror");
    if !mirror.join(".git").exists() {
        return Ok(none);
    }

    // Build the host baseline: refs whose history we know reached (or came from)
    // the host. `refs/tabtivity/incoming/*` are the host's tips at the last fetch,
    // `refs/tabtivity/backup/*` are safety snapshots, and the recorded `remote_head`
    // is the last-observed host HEAD.
    let mut negatives: Vec<String> = vec![
        format!("--glob={}", crate::brand::GIT_REF_INCOMING),
        format!("--glob={}", crate::brand::GIT_REF_BACKUP),
    ];
    let mut have_baseline = !git_in(
        &mirror,
        &["for-each-ref", crate::brand::GIT_REF_INCOMING, crate::brand::GIT_REF_BACKUP],
    )
    .is_empty();
    // Until the mirror's refs have moved to the current namespace
    // (`brand_migration::project`, at the next open), they still count from
    // the old one. Nothing is added while the name is unchanged.
    let pair = crate::brand::PAIR;
    for name in [crate::brand::Name::GIT_REF_INCOMING, crate::brand::Name::GIT_REF_BACKUP] {
        if let Some(old) = pair.legacy(name) {
            if !git_in(&mirror, &["for-each-ref", &old]).is_empty() {
                crate::brand::legacy_hit("git-refs");
                have_baseline = true;
                negatives.push(format!("--glob={old}"));
            }
        }
    }
    if let Ok(state) = storage::read_json::<crate::services::git_peer::GitPeerState>(
        &dest.join("state").join("git_peer.json"),
    ) {
        if let Some(sha) = remote_head_sha(&state) {
            // Only include a sha the mirror actually has, else rev-list errors out.
            if !git_in(
                &mirror,
                &[
                    "rev-parse",
                    "--verify",
                    "--quiet",
                    &format!("{sha}^{{commit}}"),
                ],
            )
            .is_empty()
            {
                negatives.push(sha);
                have_baseline = true;
            }
        }
    }

    // Per-branch: commits on this branch not reachable from the baseline.
    let mut branches = Vec::new();
    let mut total = 0usize;
    let heads = git_in(
        &mirror,
        &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    );
    for branch in heads.lines().map(str::trim).filter(|b| !b.is_empty()) {
        let mut args: Vec<&str> = vec!["rev-list", "--count", branch, "--not"];
        let neg_refs: Vec<&str> = negatives.iter().map(String::as_str).collect();
        args.extend_from_slice(&neg_refs);
        let count: usize = git_in(&mirror, &args).parse().unwrap_or(0);
        if count > 0 {
            total += count;
            branches.push(UnsyncedBranch {
                name: branch.to_string(),
                count,
            });
        }
    }

    Ok(UnsyncedReport {
        total,
        branches,
        verified: have_baseline,
    })
}

/// The sha of a persisted `remote_head`, if it names a concrete commit.
fn remote_head_sha(state: &crate::services::git_peer::GitPeerState) -> Option<String> {
    use crate::services::git_peer::HeadRef;
    match state.remote_head.as_ref()? {
        HeadRef::Branch { sha, .. } | HeadRef::Detached { sha } => Some(sha.clone()),
        HeadRef::Unborn => None,
    }
}

/// Permanently delete an archived project: remove its archive folder and purge
/// its time-tracking history. Irreversible.
#[tauri::command]
pub fn delete_archived_project(project_id: String) -> Result<(), String> {
    validate_project_id(&project_id)?;
    let dest = paths::archive_root().join(&project_id);
    if dest.exists() {
        fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
    }
    crate::services::agent_home::delete_scope_home(&project_id).map_err(|e| e.to_string())?;
    purge_project_time(&project_id)?;
    Ok(())
}

/// Permanently delete every archived project (Settings "Clear archive").
#[tauri::command]
pub fn clear_archive() -> Result<(), String> {
    for archived in list_archived_projects()? {
        delete_archived_project(archived.id)?;
    }
    Ok(())
}

/// Update a project's description in both `projects.json` (the pill list) and
/// the project's own `project.json`, keeping the two in sync. An empty/blank
/// description clears the field. Returns the cleaned description (or null).
#[tauri::command]
pub fn set_project_description(
    project_id: String,
    description: Option<String>,
) -> Result<Option<String>, String> {
    let cleaned = clean_description(description);

    patch_project_entry_mirrored(
        &project_id,
        |entry| {
            match &cleaned {
                Some(d) => {
                    entry
                        .extra
                        .insert("description".to_string(), Value::String(d.clone()));
                }
                None => {
                    entry.extra.remove("description");
                }
            }
            Ok(())
        },
        |project, ()| project.description = cleaned.clone(),
    )?;

    Ok(cleaned)
}

/// Rename a project: update its display `name` in both `projects.json` (the
/// pill list) and the project's own `project.json`, keeping the two in sync.
/// The on-disk `directory` is left untouched — only the human-facing name
/// changes. A blank name is rejected. Returns the cleaned (trimmed) name.
#[tauri::command]
pub fn set_project_name(project_id: String, name: String) -> Result<String, String> {
    let cleaned = name.trim().to_string();
    if cleaned.is_empty() {
        return Err("project name cannot be empty".to_string());
    }

    patch_project_entry_mirrored(
        &project_id,
        |entry| {
            entry.name = cleaned.clone();
            Ok(())
        },
        |project, ()| project.name = cleaned.clone(),
    )?;

    Ok(cleaned)
}

// ── Project folder rename ─────────────────────────────────────────────────

/// What renaming a local project's folder to a new leaf name would do, checked
/// without touching anything. The rename dialog shows it live; the rename
/// itself re-plans and refuses anything but `ok`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDirRenamePlan {
    pub current_dir: String,
    /// `<parent of current_dir>/<leaf>`; empty when the leaf is invalid.
    pub target_dir: String,
    pub leaf: String,
    /// Machine token the frontend words: `ok`, `same` (already that name),
    /// `exists` (something is already there — never overwritten or merged),
    /// `registered` (another project claims that path), `nested` (another
    /// project lives inside this folder and would lose its path), `invalid`
    /// (not a usable folder name), `missing` (the folder is not on disk, or is a
    /// link), `unsupported` (remote or VM — no local folder to own).
    pub status: String,
}

/// A single folder name that is valid on every OS Tabtivity ships to: no
/// separators, no `.`/`..`, none of Windows' reserved characters, no trailing
/// dot or space, no control characters.
fn is_valid_folder_leaf(leaf: &str) -> bool {
    !leaf.is_empty()
        && leaf.len() <= 255
        && leaf != "."
        && leaf != ".."
        && !leaf.ends_with('.')
        && !leaf.ends_with(' ')
        && !leaf
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\' | '<' | '>' | ':' | '"' | '|' | '?' | '*'))
}

/// Whether two paths are the same directory entry — true for a case-only
/// rename on a case-insensitive filesystem, where the "new" name already
/// resolves to the folder being renamed.
fn is_same_file(a: &Path, b: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match (fs::symlink_metadata(a), fs::symlink_metadata(b)) {
            (Ok(x), Ok(y)) => x.dev() == y.dev() && x.ino() == y.ino(),
            _ => false,
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (a, b);
        false
    }
}

/// Plan renaming `project_id`'s folder to `leaf` (trimmed) within its current
/// parent. Pure over the registry snapshot plus `stat`s; `is_remote` comes from
/// `services::remote` so remoteness is never inferred here.
fn plan_dir_rename(
    list: &ProjectsList,
    project_id: &str,
    is_remote: bool,
    leaf: &str,
) -> Result<ProjectDirRenamePlan, String> {
    let entry = list
        .iter()
        .find(|e| e.id == project_id)
        .ok_or_else(|| format!("project '{project_id}' not found"))?;
    let leaf = leaf.trim().to_string();
    let current = entry_directory(entry)
        .map(|d| d.trim().trim_end_matches(['/', '\\']).to_string())
        .unwrap_or_default();
    let plan = |target_dir: String, status: &str| ProjectDirRenamePlan {
        current_dir: current.clone(),
        target_dir,
        leaf: leaf.clone(),
        status: status.to_string(),
    };
    let is_vm = entry
        .extra
        .get("vm")
        .and_then(|v| v.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if is_remote || is_vm || current.is_empty() {
        return Ok(plan(String::new(), "unsupported"));
    }
    let old = PathBuf::from(&current);
    let Some(parent) = old.parent().filter(|p| !p.as_os_str().is_empty()) else {
        return Ok(plan(String::new(), "unsupported"));
    };
    // A link is renamed as the link, leaving the real folder where it was —
    // not what "rename the project folder" means.
    if !fs::symlink_metadata(&old).is_ok_and(|m| m.is_dir()) {
        return Ok(plan(String::new(), "missing"));
    }
    if !is_valid_folder_leaf(&leaf) {
        return Ok(plan(String::new(), "invalid"));
    }
    let target = parent.join(&leaf);
    let target_str = target.to_string_lossy().to_string();
    if old.file_name().is_some_and(|n| n == leaf.as_str()) {
        return Ok(plan(target_str, "same"));
    }
    // `symlink_metadata`, so a dangling link or a stray file counts as taken.
    if fs::symlink_metadata(&target).is_ok() && !is_same_file(&old, &target) {
        return Ok(plan(target_str, "exists"));
    }
    if find_project_conflict(list, &ProjectSite::Local { dir: &target_str }, Some(project_id))
        .is_some()
    {
        return Ok(plan(target_str, "registered"));
    }
    let old_key = local_dir_key(&current);
    let under_old = |p: &str| {
        let key = local_dir_key(p);
        key.strip_prefix(&old_key)
            .is_some_and(|rest| rest.starts_with('/') || rest.starts_with('\\'))
    };
    let nested = list.iter().filter(|e| e.id != project_id).any(|e| {
        entry_directory(e).is_some_and(|d| under_old(&d))
            || entry_mirror(e).is_some_and(|m| under_old(&m))
    });
    if nested {
        return Ok(plan(target_str, "nested"));
    }
    Ok(plan(target_str, "ok"))
}

/// Check what renaming a local project's folder to `leaf` would do (see
/// [`ProjectDirRenamePlan`]). Read-only; backs the rename dialog's live line.
#[tauri::command]
pub fn plan_project_dir_rename(
    project_id: String,
    leaf: String,
) -> Result<ProjectDirRenamePlan, String> {
    let list = read_projects_list()?;
    let is_remote = crate::services::remote::remote_target_for(&project_id).is_some();
    plan_dir_rename(&list, &project_id, is_remote, &leaf)
}

/// Rename `old` to `new` without ever replacing or merging into something at
/// `new`. On Unix the free name is claimed first with an exclusive `mkdir`, and
/// `rename(2)` then atomically swaps our own empty placeholder for the folder —
/// so a folder that appears at `new` between the check and the move makes
/// `mkdir` fail instead of being overwritten (plain `rename` would silently
/// replace an empty directory). Windows' move never replaces a directory.
fn rename_dir_no_replace(old: &Path, new: &Path) -> Result<(), String> {
    if is_same_file(old, new) {
        // Case-only change on a case-insensitive filesystem: same entry.
        return fs::rename(old, new).map_err(|e| e.to_string());
    }
    #[cfg(unix)]
    {
        fs::create_dir(new).map_err(|e| match e.kind() {
            std::io::ErrorKind::AlreadyExists => {
                format!("{} already exists; nothing was renamed", new.display())
            }
            _ => e.to_string(),
        })?;
        if let Err(e) = fs::rename(old, new) {
            // Only ever removes the placeholder while it is still empty.
            let _ = fs::remove_dir(new);
            return Err(e.to_string());
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        if fs::symlink_metadata(new).is_ok() {
            return Err(format!("{} already exists; nothing was renamed", new.display()));
        }
        fs::rename(old, new).map_err(|e| e.to_string())
    }
}

/// Rename a **closed** local project's folder to `<same parent>/<leaf>`, then
/// re-point everything Tabtivity stores under the old path: the registry entry
/// (`directory`, `local_file`, a pinned venv interpreter…), the moved
/// `project.json`, and the saved tab layout. Refuses anything the plan does not
/// call `ok`, and refuses an open project — its shells and agents hold the old
/// path and would write back into a folder that no longer exists. Linked git
/// worktrees are re-pointed with `git worktree repair`. Returns the new entry.
#[tauri::command]
pub async fn rename_project_dir(project_id: String, leaf: String) -> Result<ProjectEntry, String> {
    run_off_thread(move || rename_project_dir_blocking(&project_id, &leaf)).await
}

fn rename_project_dir_blocking(project_id: &str, leaf: &str) -> Result<ProjectEntry, String> {
    let list = read_projects_list()?;
    let is_remote = crate::services::remote::remote_target_for(project_id).is_some();
    let plan = plan_dir_rename(&list, project_id, is_remote, leaf)?;
    if plan.status != "ok" {
        return Err(format!("The project folder can't be renamed ({}).", plan.status));
    }
    let is_closed = |e: &ProjectEntry| e.status == "inactive";
    if !list.iter().any(|e| e.id == project_id && is_closed(e)) {
        return Err("Close the project before renaming its folder.".to_string());
    }
    let old = PathBuf::from(&plan.current_dir);
    let new = PathBuf::from(&plan.target_dir);
    rename_dir_no_replace(&old, &new)?;

    let (old_s, new_s) = (plan.current_dir.as_str(), plan.target_dir.as_str());
    let patched = patch_project_entry(project_id, |entry| {
        if !is_closed(entry) {
            return Err("The project was reopened while its folder was renamed.".to_string());
        }
        let mut value = serde_json::to_value(&*entry).map_err(|e| e.to_string())?;
        storage::rewrite_path_prefix(&mut value, old_s, new_s);
        *entry = serde_json::from_value(value).map_err(|e| e.to_string())?;
        Ok(entry.clone())
    });
    let updated = match patched {
        Ok(entry) => entry,
        Err(e) => {
            // Nothing points at the new name yet: put the folder back.
            return match fs::rename(&new, &old) {
                Ok(()) => Err(e),
                Err(back) => Err(format!(
                    "{e} — and the folder could not be moved back from {} ({back})",
                    new.display()
                )),
            };
        }
    };

    // The registry is the source of truth; the rest is best effort, reported.
    let project_file = PathBuf::from(&updated.local_file);
    if project_file.exists() {
        let rewritten = storage::read_json::<Value>(&project_file)
            .map_err(|e| e.to_string())
            .and_then(|mut v| {
                if storage::rewrite_path_prefix(&mut v, old_s, new_s) {
                    storage::write_json_atomic(&project_file, &v).map_err(|e| e.to_string())
                } else {
                    Ok(())
                }
            });
        if let Err(e) = rewritten {
            eprintln!("rename_project_dir: project.json not updated: {e}");
        }
    }
    if let Err(e) =
        crate::services::terminal_service::rewrite_session_paths(project_id, old_s, new_s)
    {
        eprintln!("rename_project_dir: saved tab layout not updated: {e}");
    }
    if new.join(".git").exists() {
        if let Err(e) = repair_moved_worktrees(&new, old_s, new_s) {
            eprintln!("rename_project_dir: git worktree repair: {e}");
        }
    }
    Ok(updated)
}

/// Re-point a repo's linked worktrees after its folder moved from `old` to
/// `new` (`repo` is the new path). Linked worktrees record absolute paths both
/// ways. The ones that lived inside the folder (`.tabtivity/worktrees/…`)
/// moved with it, and repair can only find them when told where they went.
/// Runs through the hardened git command like every local git spawn.
fn repair_moved_worktrees(repo: &Path, old: &str, new: &str) -> Result<(), String> {
    let moved = moved_linked_worktrees(repo, old, new);
    let out = crate::commands::git::hardened_git_command_in(repo, &["worktree", "repair"])
        .args(&moved)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// The new locations of a repo's linked worktrees that sat under the renamed
/// folder: each `.git/worktrees/<n>/gitdir` still names `<old>/…/<wt>/.git`.
fn moved_linked_worktrees(repo: &Path, old: &str, new: &str) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(repo.join(".git").join("worktrees")) else {
        return Vec::new();
    };
    let (old, new) = (git_path_form(old), git_path_form(new));
    entries
        .flatten()
        .filter_map(|e| fs::read_to_string(e.path().join("gitdir")).ok())
        .filter_map(|gitdir| {
            let mut v = Value::String(gitdir.trim().to_string());
            if !storage::rewrite_path_prefix(&mut v, &old, &new) {
                return None;
            }
            let moved = PathBuf::from(v.as_str()?);
            moved.parent().map(Path::to_path_buf)
        })
        .collect()
}

/// A path as git writes it into a `gitdir` file: `/`-separated on every OS,
/// while a Windows folder path from `projects.json` uses `\`.
fn git_path_form(path: &str) -> String {
    if cfg!(windows) {
        path.replace('\\', "/")
    } else {
        path.to_string()
    }
}

/// Whether a currently-detected repo source still needs a user decision:
/// either nothing is configured yet, or what *is* configured textually
/// matches the detected value (so it was very likely adopted from an earlier
/// detection) but its hash has moved — the Dockerfile changed underneath an
/// approval that no longer describes what would actually build. A `dockerfile`/
/// `image` set to something detection would *not* produce is always a
/// deliberate manual choice (the knobs dialog, `set_project_sandbox_spec`) and
/// is never second-guessed here.
fn source_needs_decision(spec: &SandboxSpec, detected: &DetectedSpecSource) -> bool {
    if spec.spec_source_hash.as_deref() == Some(detected.hash.as_str()) {
        return false;
    }
    let nothing_configured = spec.dockerfile.is_none() && spec.image.is_none();
    let matches_current_assignment = match detected.kind {
        DetectedSpecKind::Dockerfile => spec.dockerfile.as_deref() == Some(detected.value.as_str()),
        DetectedSpecKind::DevcontainerImage => {
            spec.image.as_deref() == Some(detected.value.as_str())
        }
    };
    nothing_configured || matches_current_assignment
}

/// Toggle the project container for a project in both `projects.json` (so the
/// pill list / frontend can flag it without reading project.json) and the
/// project's own `project.json`. **Spec-preserving**: only `enabled` is
/// flipped — hand-tuned `image`/`memory`/`network`/… survive a disable/enable
/// round-trip (the spec stays stored with `enabled:false` rather than being
/// cleared).
///
/// **O#143**: an in-repo `Dockerfile`/devcontainer `image` is never adopted
/// silently — `docker build` runs its `RUN` steps as root with full network,
/// a strictly larger blast radius than the session container. On enable, if
/// the repo currently declares a source and [`source_needs_decision`] says it
/// hasn't been decided about yet, this returns `NeedsConfirmation` and writes
/// nothing; the frontend shows a dialog naming the risk and calls again with
/// `source_decision` carrying the *same* hash plus the user's yes/no. A hash
/// that no longer matches the live detection (the file changed between the
/// two calls, or the caller is answering a stale dialog) is refused the same
/// way — `NeedsConfirmation` again, with the current source.
#[tauri::command]
pub fn set_project_sandbox(
    project_id: String,
    enabled: bool,
    source_decision: Option<SandboxSourceDecision>,
) -> Result<SandboxToggleOutcome, String> {
    let list = read_projects_list()?;
    let entry = list
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| format!("project '{project_id}' not found"))?;

    // The trust tiers are exclusive (`docs/vm_projects_plan.md`): a project
    // living inside a VM must never also enable the Docker sandbox — the
    // container's bind-mount is precisely the shared filesystem the VM tier
    // exists to not have.
    if enabled
        && entry
            .extra
            .get("vm")
            .and_then(|v| v.get("enabled"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    {
        return Err(
            "This project lives inside a VM; the VM and container tiers are exclusive.".to_string(),
        );
    }

    // Existing spec: the `projects.json` mirror in the state dir is the ONLY
    // source. There used to be a `project.json` fallback for entries predating the
    // mirror, but `project.json` lives inside the project tree — inside the
    // container's own rw mount and inside any cloned repo — so it could seed the
    // spec that decides which Dockerfile gets built as root and whether the
    // container runs with `--network host`. A pre-mirror project simply starts from
    // the default spec on its next toggle, which is trivially re-set.
    let existing: Option<SandboxSpec> = entry
        .extra
        .get("sandbox")
        .and_then(|v| serde_json::from_value(v.clone()).ok());
    let mut spec = existing.unwrap_or_default();
    spec.enabled = enabled;

    if enabled {
        if let Some(dir) = entry
            .extra
            .get("directory")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            if let Some(detected) = crate::services::sandbox::detect_spec_source(Path::new(dir)) {
                if source_needs_decision(&spec, &detected) {
                    match source_decision {
                        Some(decision) if decision.hash == detected.hash => {
                            spec.spec_source_hash = Some(detected.hash.clone());
                            if decision.adopt {
                                match detected.kind {
                                    DetectedSpecKind::Dockerfile => {
                                        spec.dockerfile = Some(detected.value.clone());
                                        spec.image = None;
                                    }
                                    DetectedSpecKind::DevcontainerImage => {
                                        spec.image = Some(detected.value.clone());
                                        spec.dockerfile = None;
                                    }
                                }
                            } else {
                                // Explicit decline: clear a stale match so the
                                // container falls back to the built-in default
                                // image rather than rebuilding the declined one.
                                match detected.kind {
                                    DetectedSpecKind::Dockerfile
                                        if spec.dockerfile.as_deref()
                                            == Some(detected.value.as_str()) =>
                                    {
                                        spec.dockerfile = None;
                                    }
                                    DetectedSpecKind::DevcontainerImage
                                        if spec.image.as_deref()
                                            == Some(detected.value.as_str()) =>
                                    {
                                        spec.image = None;
                                    }
                                    _ => {}
                                }
                            }
                        }
                        _ => {
                            return Ok(SandboxToggleOutcome::NeedsConfirmation {
                                source: detected,
                            });
                        }
                    }
                }
            }
        }
    }

    write_project_sandbox_spec(&project_id, &spec)?;
    Ok(SandboxToggleOutcome::Applied { spec })
}

/// Replace a project's container spec (the knobs dialog's save). `enabled` is
/// taken from the incoming spec verbatim; blank strings are normalized away so
/// "cleared field" and "never set" serialize identically. Returns the stored
/// spec.
#[tauri::command]
pub fn set_project_sandbox_spec(
    project_id: String,
    mut spec: SandboxSpec,
) -> Result<SandboxSpec, String> {
    let clean = |v: &mut Option<String>| {
        if v.as_deref().map(str::trim).is_none_or(str::is_empty) {
            *v = None;
        } else if let Some(s) = v.as_mut() {
            *s = s.trim().to_string();
        }
    };
    clean(&mut spec.image);
    clean(&mut spec.dockerfile);
    clean(&mut spec.memory);
    clean(&mut spec.cpus);
    clean(&mut spec.network);
    // Refuse `host` (and any non-name) here, where the user can see the error —
    // `services::sandbox::harden_opts` additionally drops an invalid network at
    // spawn, so a spec written before this check still can't remove isolation.
    if let Some(net) = spec.network.as_deref() {
        crate::services::sandbox::validate_network(net)?;
    }

    write_project_sandbox_spec(&project_id, &spec)?;
    Ok(spec)
}

/// Set (or clear) a project's override of the global `agent_remote_control`
/// setting (O#59). `None` clears the override (Claude tabs of this project go
/// back to inheriting the global setting); `Some(true)`/`Some(false)` force it
/// on/off regardless of the global value. Mirrors `set_project_python`'s
/// shape: written into both the `projects.json` entry's flattened
/// `extra["remote_control"]` (the copy `commands::terminal::pty_spawn` trusts)
/// and the project's own `project.json` (display/export only).
#[tauri::command]
pub fn set_project_remote_control(
    project_id: String,
    remote_control: Option<bool>,
) -> Result<Option<bool>, String> {
    patch_project_entry_mirrored(
        &project_id,
        |entry| {
            match remote_control {
                Some(v) => {
                    entry
                        .extra
                        .insert("remote_control".into(), serde_json::Value::Bool(v));
                }
                None => {
                    entry.extra.remove("remote_control");
                }
            }
            Ok(())
        },
        |project, ()| project.remote_control = remote_control,
    )?;
    Ok(remote_control)
}

/// Authority stays in projects.json; never copy this grant into the project tree.
#[tauri::command]
pub fn set_project_schedule_mcp(project_id: String, level: String) -> Result<(), String> {
    if !matches!(level.as_str(), "off" | "propose" | "apply") { return Err("invalid schedule MCP level".into()); }
    patch_project_entry(&project_id, |entry| {
        entry.extra.insert("schedule_mcp".into(), serde_json::Value::String(level));
        Ok(())
    })
}

/// The agent-push policy (`services::git_push_mcp`): level and protected
/// branches. Authority stays in projects.json; never copied into the tree.
#[tauri::command]
pub fn set_project_git_push_mcp(project_id: String, level: Option<String>, protected: Option<Vec<String>>) -> Result<crate::services::git_push_mcp::ProjectPolicy, String> {
    let level = match level.as_deref() {
        None => None,
        Some("off") => Some(crate::services::git_push_mcp::Level::Off),
        Some("propose") => Some(crate::services::git_push_mcp::Level::Propose),
        Some("apply") => Some(crate::services::git_push_mcp::Level::Apply),
        Some(_) => return Err("invalid agent push level".into()),
    };
    crate::services::git_push_mcp::set_policy(&project_id, level, protected, None)
}

/// Persist a container spec into both stores: the `projects.json` entry's
/// flattened `sandbox` (the always-local mirror the spawn path reads) and the
/// project's own `project.json` (best effort — the list is the source of truth).
fn write_project_sandbox_spec(project_id: &str, spec: &SandboxSpec) -> Result<(), String> {
    let value = serde_json::to_value(spec).map_err(|e| e.to_string())?;
    patch_project_entry_mirrored(
        project_id,
        |entry| {
            entry.extra.insert("sandbox".to_string(), value);
            Ok(())
        },
        |project, ()| project.sandbox = Some(spec.clone()),
    )
}

/// Toggle-time container preflight: is docker installed, is the daemon up, does
/// the image exist? For a missing image the report carries the shell command
/// that provides it, so the frontend can run it in a fresh terminal tab
/// (one-click, per house convention) instead of telling the user to do it.
// `(async)` on a sync fn: the three docker probes (`docker --version`,
// `docker info`, `docker image inspect`) run on tauri's blocking pool instead of
// the main thread — `docker info` against a wedged daemon hangs rather than
// failing, and froze the whole window with it. The probes themselves stay
// unbounded, exactly as before; only the thread they block moved.
#[tauri::command(async)]
pub fn sandbox_preflight(project_id: String) -> crate::services::sandbox::PreflightReport {
    crate::services::sandbox::preflight_report(&project_id)
}

/// Set (or clear) the OpenVPN client config on a **remote** project's SSH spec,
/// mirrored into both `projects.json` (the flattened `remote` extra the frontend
/// reads) and the project's own `project.json`. This exists because a remote
/// project may be created/extended on a network that needs no VPN (so no config
/// is stored), then later reconnected from a VPN-gated network — the Connect
/// dialog attaches the config here so it's remembered for next time.
///
/// `config = Some(path)` attaches the tunnel; `None`/blank removes it. `username`
/// is stored alongside for `auth-user-pass` configs (it is not a secret); blank
/// clears it. Errors if the project isn't remote. Returns the stored config path
/// ("" when cleared).
#[tauri::command]
pub fn set_project_openvpn(
    project_id: String,
    config: Option<String>,
    username: Option<String>,
) -> Result<String, String> {
    let username = username
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty());
    let spec = config
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(|c| OpenVpnSpec {
            config: c.to_string(),
            username: username.clone(),
            extra: HashMap::new(),
        });

    patch_remote_spec(&project_id, |remote| remote.openvpn = spec.clone())?;

    Ok(spec.map(|s| s.config).unwrap_or_default())
}

/// Apply `patch` to a **remote** project's SSH spec in both places it is stored:
/// `projects.json` (the flattened `remote` extra, which is the always-local source
/// of truth `services::remote::remote_target_for` reads) and the project's own
/// `project.json` (best effort — a remote project's copy may be unreachable).
/// Errors if the project is unknown or not remote.
fn patch_remote_spec(project_id: &str, patch: impl Fn(&mut RemoteSpec)) -> Result<(), String> {
    patch_project_entry_mirrored(
        project_id,
        |entry| {
            let remote_val = entry
                .extra
                .get_mut("remote")
                .ok_or_else(|| "project is not remote".to_string())?;
            let mut remote: RemoteSpec =
                serde_json::from_value(remote_val.clone()).map_err(|e| e.to_string())?;
            patch(&mut remote);
            *remote_val = serde_json::to_value(&remote).map_err(|e| e.to_string())?;
            Ok(())
        },
        |project, ()| {
            if let Some(r) = project.remote.as_mut() {
                patch(r);
            }
        },
    )
}

/// Opt a **remote** project in/out of auto-connect (launch + activation bring the
/// SSH — and, only if the host isn't directly reachable, the VPN — up with no
/// prompt). The frontend only offers this once the connection can complete
/// silently (saved SSH password, or a host recorded as `key_auth`); the connect
/// path re-checks that itself, so a stale opt-in can never produce a prompt.
/// Returns the resulting state.
#[tauri::command]
pub fn set_project_auto_connect(project_id: String, enabled: bool) -> Result<bool, String> {
    patch_remote_spec(&project_id, |remote| {
        remote.auto_connect = enabled.then_some(true);
    })?;
    Ok(enabled)
}

/// Opt a **remote** project in/out of persistent (tmux) sessions (TODO #85). The
/// feature is **default ON** for a remote project, so the field is only written
/// when the user opts *out* (`Some(false)`); turning it back on clears the field
/// (`None`) to restore the default. Returns the resulting enabled state. Applies
/// to shell/script tabs spawned after the change (each spawn reads it via the
/// frontend's per-tab `tmux_session` name).
#[tauri::command]
pub fn set_project_persist_sessions(project_id: String, enabled: bool) -> Result<bool, String> {
    patch_remote_spec(&project_id, |remote| {
        remote.persist_sessions = if enabled { None } else { Some(false) };
    })?;
    Ok(enabled)
}

/// A scope's Mobile access as `set_project_mobile_access` stored it: the
/// switch, and which paired phones it reaches (`None` = every phone, also
/// those paired later).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MobileAccessState {
    pub enabled: bool,
    pub devices: Option<Vec<String>>,
}

/// The per-phone list a `set_*_mobile_access` call stores: `None` (every
/// phone) as asked, or the asked list validated and cut to the phones paired
/// right now (`auth::scope_device_list`) — refused when nothing is left.
pub(crate) fn mobile_scope_devices(requested: Option<Vec<String>>) -> Result<Option<Vec<String>>, String> {
    let Some(requested) = requested else {
        return Ok(None);
    };
    use crate::services::mobile_control::auth;
    let paired = auth::read_paired_devices(&storage::state_dir().join("mobile-control"))?;
    auth::scope_device_list(&requested, &paired).map(Some)
}

/// Write a project entry's Mobile keys: on with its per-phone list (absent =
/// every phone), or off with both keys gone — a list never outlives the
/// switch. Every other key of the entry is left alone.
fn apply_mobile_access(project: &mut ProjectEntry, enabled: bool, devices: Option<&[String]>) {
    if !enabled {
        project.extra.remove(crate::brand::MOBILE_ACCESS_KEY);
        project.extra.remove(crate::brand::MOBILE_DEVICES_KEY);
        return;
    }
    project
        .extra
        .insert(crate::brand::MOBILE_ACCESS_KEY.into(), Value::Bool(true));
    match devices {
        Some(devices) => {
            project
                .extra
                .insert(crate::brand::MOBILE_DEVICES_KEY.into(), serde_json::json!(devices));
        }
        None => {
            project.extra.remove(crate::brand::MOBILE_DEVICES_KEY);
        }
    }
}

/// Authoritative per-project opt-in for Tabtivity Mobile. This flag lives in the
/// state-dir `projects.json`, never only in project-writable `project.json`.
/// `devices` narrows it to some paired phones (see [`mobile_scope_devices`]);
/// omitted, every phone.
#[tauri::command]
pub fn set_project_mobile_access(
    project_id: String,
    enabled: bool,
    devices: Option<Vec<String>>,
) -> Result<MobileAccessState, String> {
    let projects = get_projects()?;
    let project = projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or("project not found")?;
    if enabled {
        if project.extra.get("remote").is_some_and(|v| !v.is_null()) {
            return Err("Mobile access is available only for local projects".into());
        }
        let runtime_enabled = |key: &str| {
            project
                .extra
                .get(key)
                .and_then(|v| v.get("enabled"))
                .and_then(Value::as_bool)
                .unwrap_or(false)
        };
        if runtime_enabled("sandbox") || runtime_enabled("vm") {
            return Err("Mobile access is unavailable for container and VM projects".into());
        }
        let settings: crate::schema::Settings =
            storage::read_json(&storage::state_dir().join("settings.json")).unwrap_or_default();
        if !settings.persist_local_sessions() {
            return Err("Enable persistent local terminal sessions before Mobile access".into());
        }
        if !crate::services::tmux_local::tmux_available() {
            return Err("Mobile access requires tmux on this machine".into());
        }
    }
    let devices = if enabled { mobile_scope_devices(devices)? } else { None };
    patch_project_entry(&project_id, |project| {
        if enabled {
            if project.extra.get("remote").is_some_and(|v| !v.is_null()) {
                return Err("Mobile access is available only for local projects".into());
            }
            let runtime_enabled = |key: &str| {
                project
                    .extra
                    .get(key)
                    .and_then(|v| v.get("enabled"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            };
            if runtime_enabled("sandbox") || runtime_enabled("vm") {
                return Err("Mobile access is unavailable for container and VM projects".into());
            }
        }
        apply_mobile_access(project, enabled, devices.as_deref());
        Ok(())
    })?;
    Ok(MobileAccessState { enabled, devices })
}

/// Set (or clear) the display name for a **remote** project's primary machine —
/// the counterpart of `patch_compute_host`'s `label` for a worker. Distinct from
/// the project name: this labels the host `Project.remote.host` reaches, shown
/// wherever a project's hosts are listed side by side (System Monitor's source
/// picker, the pill's connection lamps). A blank/whitespace-only string clears it,
/// falling back to the bare host. Returns the resulting label (`None` when cleared).
#[tauri::command]
pub fn set_project_remote_label(
    project_id: String,
    label: Option<String>,
) -> Result<Option<String>, String> {
    let normalized = label
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string);
    patch_remote_spec(&project_id, |remote| remote.label = normalized.clone())?;
    Ok(normalized)
}

/// Set (or clear) the **SSH login name** a remote project's primary host is
/// reached as. The half of the credential the Connect dialog never let you enter:
/// the address is fixed at creation (`user@host`), so a project created without a
/// user — or with the wrong one — authenticated as the *local* account name with
/// no way to correct it short of recreating the project. Every login surface needs
/// it, not just the headless one: it is what `ssh_connect`/`remote_connect` send
/// **and** what `remote_login_command` types into the interactive login terminal.
///
/// A blank/whitespace-only string clears it (ssh then falls back to the local
/// account name / `~/.ssh/config`). Returns the resulting user (`None` = cleared).
///
/// Changing it **clears `key_auth`**, which is not bookkeeping: that flag records
/// that *the previous login* authenticated with no password at all, and it is what
/// makes the pill offer a promptless auto-connect. Carried over to a different
/// account it would advertise a silent connect nothing has ever proved — exactly
/// the failure `record_key_auth`'s `via_login` case exists to prevent.
///
/// The saved password moves **with** the login. The keychain is keyed
/// `ssh:{user}@{host}:{port}`, so a new login name addresses a different (empty)
/// account — which used to be described here as needing no handling, and is in
/// fact the bug: the old entry is orphaned, still on the ring, unreachable from
/// any surface, and the connect that was silent starts prompting with no
/// explanation. [`move_saved_password`] re-keys it, and only when the store is
/// actually readable (a locked ring is not evidence there was nothing to move,
/// and certainly not licence to delete). If nothing came across, the target now
/// has neither a saved password nor a proven key login, so `auto_connect` is
/// cleared too — an armed auto-connect it cannot deliver is worse than none.
#[tauri::command]
pub fn set_project_remote_user(
    project_id: String,
    user: Option<String>,
) -> Result<Option<String>, String> {
    let normalized = user
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string);
    let target = crate::services::remote::remote_target_for(&project_id);
    let current = target.as_ref().and_then(|t| t.spec.user.clone());
    if current == normalized {
        return Ok(normalized);
    }
    let has_password = target
        .as_ref()
        .map(|t| move_saved_password(&current, &normalized, &t.spec.host, t.spec.port))
        .unwrap_or(false);
    patch_remote_spec(&project_id, |remote| {
        remote.user = normalized.clone();
        remote.key_auth = None;
        if !has_password {
            remote.auto_connect = None;
        }
    })?;
    Ok(normalized)
}

/// Re-key a host's saved SSH password from one login name to another, returning
/// whether the new login has one afterwards.
///
/// Read under the old account, written under the new, then the old deleted — in
/// that order, so a failed write never costs the secret. Refuses outright while
/// the credential store is unreadable: there, `get` answers `None` for every
/// account, so "there was nothing saved" and "we could not look" are the same
/// answer, and acting on it would silently drop the password (and, since the entry
/// is keyed by host, possibly another project's).
fn move_saved_password(
    old_user: &Option<String>,
    new_user: &Option<String>,
    host: &str,
    port: Option<u16>,
) -> bool {
    use crate::services::remote_credentials as creds;
    if !creds::store_readable() {
        return false;
    }
    let old = creds::ssh_account(old_user, host, port);
    let new = creds::ssh_account(new_user, host, port);
    if old == new {
        return creds::has(&new);
    }
    let Some(secret) = creds::get(&old) else {
        return creds::has(&new);
    };
    if creds::set(&new, Some(&secret)).is_err() {
        return false;
    }
    let _ = creds::set(&old, None);
    true
}

/// Record how a remote project's host authenticated on its last successful connect
/// (`key_auth` = no password was used at all — key/agent auth). Called by
/// `remote_connect`; this is the only way the UI can know a passwordless host is
/// auto-connect-eligible, since such a host has nothing in the keychain to check.
/// A no-op when the value is unchanged, so an ordinary connect costs no write.
pub fn record_remote_key_auth(project_id: &str, key_auth: bool) -> Result<(), String> {
    let current =
        crate::services::remote::remote_target_for(project_id).and_then(|t| t.spec.key_auth);
    if current == Some(key_auth) {
        return Ok(());
    }
    patch_remote_spec(project_id, |remote| remote.key_auth = Some(key_auth))
}

/// The worker twin of `record_remote_key_auth`: record how an extra "worker" host
/// authenticated on its last successful connect (`key_auth` = no password at all —
/// key/agent auth). Called by `remote_connect` on a worker connect. Without it a
/// passwordless worker could never be marked auto-connect-eligible — it has nothing
/// in the keychain to check — so the Connect dialog's Auto-connect toggle would
/// stay permanently disabled for it. A no-op when unchanged, so an ordinary connect
/// costs no write.
pub fn record_worker_key_auth(
    project_id: &str,
    host_id: &str,
    key_auth: bool,
) -> Result<(), String> {
    let current = crate::services::remote::compute_hosts_for(project_id)
        .into_iter()
        .find(|h| h.id == host_id)
        .and_then(|h| h.spec.key_auth);
    if current == Some(key_auth) {
        return Ok(());
    }
    patch_compute_hosts(project_id, |hosts| {
        if let Some(h) = hosts.iter_mut().find(|h| h.id == host_id) {
            h.spec.key_auth = Some(key_auth);
        }
    })?;
    Ok(())
}

/// Apply `patch` to a **remote** project's extra worker hosts (`compute_hosts`,
/// `docs/multi_host_remote_plan.md`) in both places they are stored: the
/// `projects.json` entry's flattened `extra["compute_hosts"]` (the always-local
/// source of truth `services::remote::compute_hosts_for` reads) and the project's
/// own `project.json` (best effort — a remote project's copy may be unreachable).
/// Errors if the project is unknown. The list is created when absent, so this works
/// on a project that has no workers yet.
fn patch_compute_hosts(
    project_id: &str,
    patch: impl Fn(&mut Vec<ComputeHost>),
) -> Result<Vec<ComputeHost>, String> {
    patch_project_entry_mirrored(
        project_id,
        |entry| {
            let mut hosts: Vec<ComputeHost> = entry
                .extra
                .get("compute_hosts")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            patch(&mut hosts);
            let value = serde_json::to_value(&hosts).map_err(|e| e.to_string())?;
            if hosts.is_empty() {
                entry.extra.remove("compute_hosts");
            } else {
                entry.extra.insert("compute_hosts".to_string(), value);
            }
            Ok(hosts)
        },
        |project, hosts| project.compute_hosts = hosts.clone(),
    )
}

/// Persist which machine shells launched from this project run on — the choice
/// made in the `RunHostPicker`. Mirrors `set_project_python`: it writes BOTH the
/// `projects.json` entry's `extra["run_host"]` (what the frontend seeds its live
/// preference store from on load) and the `project.json` `run_host` field (keeps
/// it with the project). `location` is a `TabLocation` string (`"local"` /
/// `"remote"` / `"host:<id>"`); `None` or empty clears it (back to the primary
/// default). Returns the stored value.
#[tauri::command]
pub fn set_project_run_host(
    project_id: String,
    location: Option<String>,
) -> Result<Option<String>, String> {
    let value = location
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    patch_project_entry_mirrored(
        &project_id,
        |entry| {
            match &value {
                Some(v) => {
                    entry
                        .extra
                        .insert("run_host".into(), serde_json::Value::String(v.clone()));
                }
                None => {
                    entry.extra.remove("run_host");
                }
            }
            Ok(())
        },
        |project, ()| project.run_host = value.clone(),
    )?;
    Ok(value)
}

/// Add an extra "worker" host to a remote project (the pill's "Add machine").
/// Mints a stable `id` when the incoming spec has none, then appends it. Returns
/// the full updated host list. The primary (`Project.remote`) is untouched.
#[tauri::command]
pub fn add_compute_host(
    project_id: String,
    mut host: ComputeHost,
) -> Result<Vec<ComputeHost>, String> {
    if host.id.trim().is_empty() {
        host.id = uuid_v4();
    }
    patch_compute_hosts(&project_id, |hosts| {
        // Replace in place when the id already exists (idempotent re-add), else push.
        if let Some(existing) = hosts.iter_mut().find(|h| h.id == host.id) {
            *existing = host.clone();
        } else {
            hosts.push(host.clone());
        }
    })
}

/// Remove a worker host from a remote project. The caller disconnects it and stops
/// its fan-out first (frontend); this only drops the persisted entry. Returns the
/// remaining host list.
#[tauri::command]
pub fn remove_compute_host(
    project_id: String,
    host_id: String,
) -> Result<Vec<ComputeHost>, String> {
    patch_compute_hosts(&project_id, |hosts| hosts.retain(|h| h.id != host_id))
}

/// Patch a worker host's toggles (`sync_code` / `pull_outputs` / `auto_connect` /
/// `shared_fs` / `label` / `user`). Each argument is applied only when `Some`, so a
/// caller can flip one flag without restating the others. Unknown `host_id` is a
/// silent no-op (returns the unchanged list).
///
/// `user` is the worker twin of [`set_project_remote_user`] — the SSH login name,
/// editable from the same Connect dialog — and clears `key_auth` for the same
/// reason: it was recorded for the account being replaced.
#[tauri::command]
pub fn patch_compute_host(
    project_id: String,
    host_id: String,
    sync_code: Option<bool>,
    pull_outputs: Option<bool>,
    auto_connect: Option<bool>,
    shared_fs: Option<bool>,
    label: Option<String>,
    user: Option<String>,
) -> Result<Vec<ComputeHost>, String> {
    patch_compute_hosts(&project_id, |hosts| {
        if let Some(h) = hosts.iter_mut().find(|h| h.id == host_id) {
            if let Some(v) = &user {
                let t = v.trim();
                let next = if t.is_empty() {
                    None
                } else {
                    Some(t.to_string())
                };
                if h.spec.user != next {
                    h.spec.user = next;
                    h.spec.key_auth = None;
                }
            }
            if let Some(v) = shared_fs {
                h.shared_fs = v;
            }
            if let Some(v) = sync_code {
                h.sync_code = v;
            }
            if let Some(v) = pull_outputs {
                h.pull_outputs = v;
            }
            if let Some(v) = auto_connect {
                h.spec.auto_connect = v.then_some(true);
            }
            if let Some(v) = &label {
                let t = v.trim();
                h.spec.label = if t.is_empty() {
                    None
                } else {
                    Some(t.to_string())
                };
            }
        }
    })
}

/// Normalize a list of category tags: trim each, drop blanks, and de-duplicate
/// case-insensitively (first spelling wins), preserving order. Mirrors the
/// frontend `cleanCategories` so storage stays canonical regardless of caller.
fn clean_categories(raw: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for r in raw {
        let c = r.split_whitespace().collect::<Vec<_>>().join(" ");
        if c.is_empty() {
            continue;
        }
        if seen.insert(c.to_lowercase()) {
            out.push(c);
        }
    }
    out
}

/// Set a project's category tags in both `projects.json` (the pill list) and the
/// project's own `project.json`, keeping the two in sync. Categories color/group
/// the project in the cloud and the pill bar. An empty list clears the field
/// entirely. Returns the cleaned, de-duplicated list that was stored.
#[tauri::command]
pub fn set_project_categories(
    project_id: String,
    categories: Vec<String>,
) -> Result<Vec<String>, String> {
    let cleaned = clean_categories(categories);

    let value = if cleaned.is_empty() {
        None
    } else {
        Some(serde_json::to_value(&cleaned).map_err(|e| e.to_string())?)
    };
    patch_project_entry_mirrored(
        &project_id,
        |entry| {
            match &value {
                Some(v) => {
                    entry.extra.insert("categories".to_string(), v.clone());
                }
                None => {
                    entry.extra.remove("categories");
                }
            }
            Ok(())
        },
        |project, ()| match &value {
            Some(v) => {
                project.extra.insert("categories".to_string(), v.clone());
            }
            None => {
                project.extra.remove("categories");
            }
        },
    )?;

    Ok(cleaned)
}

/// Enable or disable git version control for an existing project.
///
/// **Destructive when disabling.** Disabling deletes the project's `.git`
/// directory and `.gitignore` file outright — every commit, branch, stash,
/// and remote is gone and cannot be recovered — and moves the project to
/// `git_type` `"none"`, the same state a "No git (local files only)" project
/// starts in. Enabling runs
/// `git init` (a no-op if a repo already exists), writes the default
/// `.gitignore` if missing (same as `scaffold_project`), and moves the
/// project to `git_type` `"local"`.
///
/// Returns the resulting `git_type`. Mirrors the change into both
/// `projects.json` and `project.json`, like `set_project_sandbox`.
#[tauri::command]
pub fn set_project_git_disabled(project_id: String, disabled: bool) -> Result<String, String> {
    // projects.json — locate the entry and resolve its on-disk directory.
    let list = read_projects_list()?;
    let entry = list
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| format!("project '{project_id}' not found"))?;
    let directory = entry
        .extra
        .get("directory")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| "project has no directory".to_string())?;
    if !directory.is_dir() {
        return Err(format!(
            "project directory does not exist: {}",
            directory.display()
        ));
    }

    let git_dir = directory.join(".git");
    let new_git_type = if disabled {
        // Destroy version-control history. `.git` is the single source of truth
        // for it, so removing the directory is the whole operation.
        if git_dir.exists() {
            fs::remove_dir_all(&git_dir).map_err(|e| format!("failed to remove .git: {e}"))?;
        }
        let gitignore = directory.join(".gitignore");
        if gitignore.exists() {
            fs::remove_file(&gitignore).map_err(|e| format!("failed to remove .gitignore: {e}"))?;
        }
        "none".to_string()
    } else {
        if !git_dir.exists() {
            crate::services::git_init::init_repo(&directory)
                .map_err(|e| format!("git init failed: {e}"))?;
        }
        let gitignore = directory.join(".gitignore");
        if !gitignore.exists() {
            fs::write(&gitignore, GITIGNORE_DEFAULT)
                .map_err(|e| format!("failed to write .gitignore: {e}"))?;
        }
        "local".to_string()
    };

    // Mirror the new push-axis type into the flattened entry + project.json.
    patch_project_entry_mirrored(
        &project_id,
        |entry| {
            entry
                .extra
                .insert("git_type".to_string(), Value::String(new_git_type.clone()));
            Ok(())
        },
        |project, ()| project.git_type = Some(new_git_type.clone()),
    )?;

    Ok(new_git_type)
}

// ── Per-project project.json ───────────────────────────────────────────────

#[tauri::command]
pub fn load_project(local_file: String) -> Result<Project, String> {
    let path = PathBuf::from(&local_file);
    let mut project: Project = storage::read_json(&path).map_err(|e| e.to_string())?;
    if let Some(gt) = project.git_type.as_deref() {
        project.git_type = Some(normalize_git_type(gt));
    }
    // The layout and the app list are NOT served from here any more. They live in
    // `<state_dir>/sessions/<id>/` (see `services::terminal_service`), because
    // `project.json` sits in the project container's writable mount and in any
    // cloned repository, and every one of these fields is read back by the host as
    // something to execute. Blanking them keeps a stale in-tree copy from reaching
    // a caller that still reads `Project` wholesale.
    project.tab_layout = None;
    project.tab_groups = None;
    project.open_tab_sessions = None;
    project.open_apps = None;
    Ok(project)
}

/// The project's saved tab layout — the frontend's relaunch restore path.
///
/// Split out of `load_project` when the layout moved to the state dir: the two
/// answer different questions now (what this project *is* vs. what it should
/// reopen), and only one of them is keyed by a trustworthy id.
#[tauri::command]
pub fn load_tab_session(project_id: String) -> crate::schema::session::TerminalSession {
    crate::services::terminal_service::load_terminal_session(&project_id)
}

/// The event every window receives when a scope's shared tab set moved:
/// `{ scope, version, ops }` (headless owner plan, H1). A client whose known
/// version skipped re-fetches the snapshot.
pub const WORKSPACE_PATCH_EVENT: &str = "workspace:patch";

/// A scope's tab set with its version — what a client hydrates from
/// (`services::workspace::snapshot`). Replaces [`load_tab_session`] for
/// clients that then write through [`workspace_sync`].
#[tauri::command]
pub fn workspace_snapshot(project_id: String) -> Result<crate::services::workspace::Snapshot, String> {
    crate::services::workspace::snapshot(&project_id)
}

/// Apply a client's view of a scope onto the shared tab set: the difference
/// between what it sends and what it knew at `base_version` is the change it
/// meant, merged onto the current set (`services::workspace::sync`). Same
/// payload as [`save_tab_layout`] plus the version, so the frontend's one
/// persisted shape (`toSavedTabEntry`) stays the one shape. Answers the new
/// version and the stored tabs with their ids, and tells every window what
/// changed.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn workspace_sync(
    app: tauri::AppHandle,
    project_id: String,
    local_file: String,
    base_version: Option<u64>,
    tabs: Vec<crate::schema::project::TabEntry>,
    groups: Option<Value>,
    sessions: Option<Value>,
    active_tab_index: Option<usize>,
    allow_clear: bool,
) -> Result<crate::services::workspace::SyncOutcome, String> {
    let client = crate::services::workspace::ClientSync {
        base_version: base_version.unwrap_or(0),
        tabs,
        groups,
        sessions,
        active_tab_index,
        allow_clear,
    };
    let outcome = crate::services::workspace::sync(&project_id, &local_file, client)?;
    if !outcome.ops.is_empty() {
        use tauri::Emitter;
        let _ = app.emit(
            WORKSPACE_PATCH_EVENT,
            serde_json::json!({ "scope": project_id, "version": outcome.version, "ops": outcome.ops }),
        );
    }
    Ok(outcome)
}

/// Adopt the layout saved in the project **folder** (`.tabtivity/sessions/`) as this
/// project's session state. Explicit user action only — see
/// `terminal_service::adopt_project_tree_session`.
#[tauri::command]
pub fn adopt_folder_tab_layout(
    project_id: String,
    local_file: String,
) -> Result<crate::schema::session::TerminalSession, String> {
    crate::services::terminal_service::adopt_project_tree_session(&project_id, &local_file)
}

#[tauri::command]
pub fn save_project(local_file: String, project: Project) -> Result<(), String> {
    let path = PathBuf::from(&local_file);
    storage::write_json(&path, &project).map_err(|e| e.to_string())
}

/// Save only the tab layout — into `<state_dir>/sessions/<project_id>/`, plus the
/// export copy in the project folder. `project_id` is what it is keyed by; the
/// root scope passes the literal `"root"` (persisted like any project, minus the
/// export copy, since it has no project folder). A bare `None` persists nothing.
///
/// `allow_clear` licenses an EMPTY `tabs` to erase the saved layout. The frontend
/// sets it only for a scope it has actually hydrated and that genuinely holds no
/// tabs; every other empty save is a no-op. See `terminal_service`.
#[tauri::command]
pub fn save_tab_layout(
    project_id: Option<String>,
    local_file: String,
    tabs: Vec<crate::schema::project::TabEntry>,
    groups: Option<Value>,
    sessions: Option<Value>,
    allow_clear: bool,
) -> Result<(), String> {
    crate::services::terminal_service::save_tab_layout(
        project_id.as_deref(),
        &local_file,
        &tabs,
        groups,
        sessions,
        allow_clear,
    )
}

/// `~/tabtivity/root` — the working directory of everything that belongs to no
/// project (the root control terminal, and now the side panel's file tree over
/// the same folder, which is where data lands while it is only being looked at
/// or before it has a project to belong to).
///
/// It is **created here**, not only by the first root terminal that spawns into
/// it (`pty_spawn`). That used to be the only path, so a session where no root
/// terminal was ever opened had no such folder at all — and a file view is the
/// one surface that reads the directory rather than being handed to a shell
/// that would create it. A create that fails is not reported: the answer is the
/// path either way, and every command that then touches it fails with its own,
/// more specific error.
#[tauri::command]
pub fn root_work_dir() -> String {
    let dir = storage::root_work_dir();
    let _ = std::fs::create_dir_all(&dir);
    dir.to_string_lossy().to_string()
}

#[tauri::command]
pub fn projects_root_dir() -> String {
    projects_root().to_string_lossy().to_string()
}

/// The default parent directory for a remote (SSH) project's local mirror — the
/// top-level `tabtivity/projects-ssh/` root. The New/Import dialog seeds its "Local
/// location" picker from this so its default matches `default_remote_mirror`.
#[tauri::command]
pub fn remote_mirror_root_dir() -> String {
    paths::projects_ssh_root().to_string_lossy().to_string()
}

/// Open a directory in the OS file manager (Files/Finder/Explorer).
#[tauri::command]
pub fn open_in_file_manager(path: String) -> Result<(), String> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {path}"));
    }
    opener::open(&dir).map_err(|e| e.to_string())
}

/// The local mirror status for a remote (SSH) project — backs the pill's "Show on
/// disk". Returns the current mirror root (its stored override or the default),
/// whether that directory still exists on disk (a user may have deleted it), and
/// a suggested fresh location (`ssh/<name>` under the projects root) to default a
/// relocation picker to. Errors for a local project.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorStatus {
    pub path: String,
    pub exists: bool,
    pub suggested: String,
}

#[tauri::command]
pub fn remote_mirror_status(project_id: String, name: String) -> Result<MirrorStatus, String> {
    if crate::services::remote::remote_target_for(&project_id).is_none() {
        return Err("not a remote project".to_string());
    }
    let dir = crate::services::remote_sync::mirror_dir(&project_id);
    let suggested = default_remote_mirror(&name, &project_id, &read_projects_list()?);
    Ok(MirrorStatus {
        exists: dir.is_dir(),
        path: dir.to_string_lossy().to_string(),
        suggested: suggested.to_string_lossy().to_string(),
    })
}

/// Point a remote (SSH) project's local mirror at `path`, creating the directory,
/// and persist the choice in both `projects.json` (`extra["mirror"]`, the source
/// of truth `remote_sync::mirror_dir` reads) and the project's `project.json`.
/// Used when the user relocates a mirror whose folder was deleted. Returns the
/// resolved absolute path.
#[tauri::command]
pub fn set_remote_mirror_dir(project_id: String, path: String) -> Result<String, String> {
    if crate::services::remote::remote_target_for(&project_id).is_none() {
        return Err("not a remote project".to_string());
    }
    let dir = PathBuf::from(path.trim());
    if dir.as_os_str().is_empty() {
        return Err("Mirror path is empty".to_string());
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let resolved = dir.to_string_lossy().to_string();
    persist_mirror_dir(&project_id, &resolved)?;
    Ok(resolved)
}

/// Persist a remote project's chosen mirror root into both `projects.json`
/// (`extra["mirror"]`, the always-local source of truth `remote_sync::mirror_dir`
/// reads) and the project's `project.json` (best effort). Shared by
/// `set_remote_mirror_dir` and `move_remote_mirror`.
fn persist_mirror_dir(project_id: &str, resolved: &str) -> Result<(), String> {
    patch_project_entry_mirrored(
        project_id,
        |entry| {
            entry
                .extra
                .insert("mirror".to_string(), Value::String(resolved.to_string()));
            Ok(())
        },
        |project, ()| project.mirror = Some(resolved.to_string()),
    )
}

/// Move a remote (SSH) project's local mirror folder to a new location: the user
/// picks a **parent** directory, and the mirror is relocated to
/// `<parent_dir>/<sanitized-name>` (disambiguated with a short id suffix if that
/// leaf is taken). The existing mirror bytes are moved (rename, with a
/// copy-then-remove fallback across filesystems); a never-synced mirror simply
/// has the new folder created. Persists the new pointer and returns its absolute
/// path. Errors for a local project. Backs the pill's "Move project…" option.
#[tauri::command]
pub async fn move_remote_mirror(
    project_id: String,
    name: String,
    parent_dir: String,
) -> Result<String, String> {
    run_off_thread(move || move_remote_mirror_blocking(project_id, name, parent_dir)).await
}

pub fn move_remote_mirror_blocking(
    project_id: String,
    name: String,
    parent_dir: String,
) -> Result<String, String> {
    if crate::services::remote::remote_target_for(&project_id).is_none() {
        return Err("not a remote project".to_string());
    }
    let parent = PathBuf::from(parent_dir.trim());
    if parent.as_os_str().is_empty() {
        return Err("Destination folder is empty".to_string());
    }
    fs::create_dir_all(&parent).map_err(|e| e.to_string())?;

    // Compute the new leaf under the chosen parent, mirroring `default_remote_mirror`.
    let safe = sanitize_name(&name);
    let leaf = if safe.is_empty() {
        project_id.clone()
    } else {
        safe
    };
    let candidate = parent.join(&leaf);
    let new_root = if candidate.exists() {
        parent.join(format!("{leaf}-{}", &project_id[..project_id.len().min(8)]))
    } else {
        candidate
    };

    let old = crate::services::remote_sync::mirror_dir(&project_id);
    if old.exists() && old != new_root {
        // A plain rename fails across drives/filesystems. Fall back to
        // copy-then-remove for that case only; `new_root` is a free name, so any
        // other failure (a file held open, a permission refusal) is reported
        // rather than turned into a duplicate tree.
        match fs::rename(&old, &new_root) {
            Ok(()) => {}
            Err(e) if crate::paths::is_cross_device(&e) => {
                copy_dir_all(&old, &new_root)?;
                fs::remove_dir_all(&old).map_err(|e| e.to_string())?;
            }
            Err(e) => return Err(format!("could not move the mirror: {e}")),
        }
    } else {
        fs::create_dir_all(&new_root).map_err(|e| e.to_string())?;
    }

    let resolved = new_root.to_string_lossy().to_string();
    persist_mirror_dir(&project_id, &resolved)?;
    Ok(resolved)
}

// ── Scaffold new project ───────────────────────────────────────────────────

/// The one file that carries real instructions. Every agent-specific doc is a
/// pointer to it (see `CLAUDE_SCAFFOLD`/`GEMINI_SCAFFOLD`), so guidance is
/// written once and every agent reads the same text instead of three stubs
/// drifting apart.
///
/// Kept to placeholders: agents load it every session, and it is the user's
/// file from the first write on — never rewritten unless still byte-identical
/// to a template Tabtivity shipped (`AGENTS_HISTORY`). So nothing about Tabtivity
/// itself goes here (the `tabtivity-send` hint comes from `services::agent_hint`
/// and the session hook), and the map of the other files is `PROJECT.md`'s.
/// Changing this text? Add the old one to `scaffold_history/` first — a test
/// pins it.
const AGENTS_SCAFFOLD: &str = r#"# Agents

Canonical instructions for every AI coding agent in this project;
`CLAUDE.md` and `GEMINI.md` import this file. Write guidance **here**, and
keep it to what an agent would otherwise get wrong: it is loaded into every
session. [PROJECT.md](./PROJECT.md) maps the rest of the project.

## Project

_What this project is, in a sentence or two._

## Running

_Build, run and test commands._

## Conventions

_Layout, style, and anything an agent must not do._
"#;

/// Claude Code pointer. `@AGENTS.md` on its own line is Claude Code's import
/// syntax, so the canonical text is actually *loaded*, not merely referenced —
/// a plain "see AGENTS.md" line would leave the agent to decide whether to open
/// it.
const CLAUDE_SCAFFOLD: &str = r#"# Claude Context

This project's instructions live in [AGENTS.md](./AGENTS.md); the import below
pulls them in. Write project guidance there, not here — keep this file for
Claude-specific overrides only.

@AGENTS.md

Other agent files: [AGENTS.md](./AGENTS.md) · [GEMINI.md](./GEMINI.md)
"#;

/// Gemini CLI pointer — same shape as `CLAUDE_SCAFFOLD`; the Gemini CLI honors
/// the same `@file` import syntax in its context file.
const GEMINI_SCAFFOLD: &str = r#"# Gemini Context

This project's instructions live in [AGENTS.md](./AGENTS.md); the import below
pulls them in. Write project guidance there, not here — keep this file for
Gemini-specific overrides only.

@AGENTS.md

Other agent files: [AGENTS.md](./AGENTS.md) · [CLAUDE.md](./CLAUDE.md)
"#;

/// The navigation hub: one file linking every other scaffold file with a line
/// on what it is for, so a fresh project can be walked from a single entry
/// point — the links are relative, so the markdown viewer's link-following
/// (#49/#50) opens each target in-app. Scaffolded like the rest (never
/// overwritten), and listed first so previews show the map before the mapped.
const PROJECT_SCAFFOLD: &str = concat!(r#"# Project Map

Start here. This file links every scaffold file with what it is for, so the
project can be navigated from one place. The links are relative and open
in "#, crate::app_name!(), r#"'s markdown viewer.

## Docs

- [README.md](./README.md) — overview: what this project is and how to use it
- [DOCUMENTATION.md](./DOCUMENTATION.md) — reference documentation
- [ROADMAP.md](./ROADMAP.md) — planned direction
- [STATUS.md](./STATUS.md) — current state
- [TODO.md](./TODO.md) — open work items
- [REMARKS.md](./REMARKS.md) — project-wide remarks attached to files and lines

## Agent instructions

- [AGENTS.md](./AGENTS.md) — canonical instructions for every AI coding agent
- [CLAUDE.md](./CLAUDE.md) — Claude Code pointer; imports AGENTS.md
- [GEMINI.md](./GEMINI.md) — Gemini CLI pointer; imports AGENTS.md

## Config

- [.claude/settings.json](./.claude/settings.json) — Claude Code permissions for this project
- [.gitignore](./.gitignore) — patterns git ignores (git-backed projects only)

_Add links to your own key files and folders here so this stays the map of
the project._
"#);

const REMARKS_SCAFFOLD: &str = r#"# Remarks

Per-file remarks. One bullet per remark:
`- [ ] [<path>:<line>](./<path>:<line>) — text`. Line optional, a hint only.
Tick a box to resolve a remark. Everything else in this file is yours.
"#;

pub const SCAFFOLD_FILES: &[(&str, &str)] = &[
    ("PROJECT.md", PROJECT_SCAFFOLD),
    ("AGENTS.md", AGENTS_SCAFFOLD),
    ("CLAUDE.md", CLAUDE_SCAFFOLD),
    ("GEMINI.md", GEMINI_SCAFFOLD),
    ("TODO.md", "# TODO\n"),
    ("REMARKS.md", REMARKS_SCAFFOLD),
    ("ROADMAP.md", "# Roadmap\n"),
    ("STATUS.md", "# Status\n"),
    ("README.md", "# Project\n"),
    ("DOCUMENTATION.md", "# Documentation\n"),
];

/// The folder a saved screen grab lands in. `tabtivity-` prefixed because the
/// plain name is one a *project* plausibly owns — a repo with its own
/// `screenshots/` of documentation images would have Tabtivity filing private
/// captures into a tracked folder, and ignoring that folder would then hide the
/// project's own files from git. The prefix makes the folder unmistakably
/// Tabtivity's, so ignoring it can never swallow something the user wrote.
pub const SCREENSHOTS_DIR: &str = crate::brand::SCREENSHOTS_DIR;

/// The folder a saved mail attachment lands in (*Save to emails folder*), named
/// on the same rule as [`SCREENSHOTS_DIR`].
pub const EMAILS_DIR: &str = crate::brand::EMAILS_DIR;

/// The name one of those folders (`Name::SCREENSHOTS_DIR`, `Name::EMAILS_DIR`)
/// goes by in the project at `root`: the name an older build gave it where the
/// project already has that folder and not the current one, the current name
/// otherwise — so a project filed into before a rename keeps its one folder
/// instead of growing a second. The old folder is the user's and stays for
/// good, which is why this is not counted as a legacy hit. Only a real
/// directory counts (a project tree is attacker-controlled; a link is not a
/// folder the app made). While the name is unchanged this never looks at the
/// disk.
pub fn generated_dir_name_for(pair: &crate::brand::Pair, root: &Path, name: crate::brand::Name) -> String {
    let current = pair.cur(name);
    let Some(old) = pair.legacy(name) else {
        return current;
    };
    let old_is_dir = fs::symlink_metadata(root.join(&old)).is_ok_and(|meta| meta.file_type().is_dir());
    if old_is_dir && fs::symlink_metadata(root.join(&current)).is_err() {
        old
    } else {
        current
    }
}

/// [`generated_dir_name_for`] under the running app's brand.
pub fn generated_dir_name(root: &Path, name: crate::brand::Name) -> String {
    generated_dir_name_for(&crate::brand::PAIR, root, name)
}

/// The folder a save into the project at `project_dir` defaults to, for the
/// dialogs that show it: `kind` is `"screenshots"` or `"emails"`. A directory
/// that is not on this machine (a remote project's) answers the current name.
#[tauri::command]
pub fn project_generated_dir(project_dir: String, kind: String) -> Result<String, String> {
    let name = match kind.as_str() {
        "screenshots" => crate::brand::Name::SCREENSHOTS_DIR,
        "emails" => crate::brand::Name::EMAILS_DIR,
        _ => return Err("unknown folder kind".into()),
    };
    Ok(generated_dir_name(Path::new(&project_dir), name))
}

// `tabtivity-screenshots/` is ignored by default because a screen grab holds
// whatever happened to be on the screen — mail, tokens, another project's
// window — and a project with a public remote is one `git add -A` away from
// publishing it. `tabtivity-emails/` is the same argument from the same direction:
// it holds correspondence somebody sent to the user, not project source, and
// the consent that filed it was consent to keep it, never to publish it.
//
// The unprefixed `screenshots/` and `emails/` stay on the list. They are what
// Tabtivity wrote into before the rename, so dropping them would un-ignore a
// folder of already-filed private data the moment a project's `.gitignore` was
// regenerated — the exact leak these entries exist to prevent.
//
// The same goes for the two folders under the app's old name: a project that
// has one keeps saving into it (`generated_dir_name`), so its rule stays on
// the list for good.
pub const GITIGNORE_DEFAULT: &str = concat!("__pycache__/\n*.pyc\n.venv/\nnode_modules/\ntarget/\ndist/\nbuild/\n.env\n.env.local\n.DS_Store\n*.log\n*.swp\n*.swo\n.idea/\n.", crate::app_slug!(), "/\n", crate::app_slug!(), "-screenshots/\n", crate::app_slug!(), "-emails/\n", crate::legacy_slug!(), "-screenshots/\n", crate::legacy_slug!(), "-emails/\nscreenshots/\nemails/\nproject.json\n");

pub const CLAUDE_SETTINGS: &str = r#"{"permissions":{"allow":[],"deny":[]}}"#;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaffoldPreviewItem {
    pub path: String,
    pub exists: bool,
    pub kind: String,
}

/// Write the standard Tabtivity project scaffold into a directory.
///
/// When `with_git` is false the scaffold files are still written but no git
/// repository is initialized — used for "local, no git" projects (git_type
/// `"none"`).
pub fn scaffold_project(dir: &Path, with_git: bool) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;

    for (name, content) in SCAFFOLD_FILES {
        write_scaffold_file(&dir.join(name), content)?;
    }
    if with_git {
        write_scaffold_file(&dir.join(".gitignore"), GITIGNORE_DEFAULT)?;
    }
    if let Some(dot_claude) = scaffold_claude_dir(dir)? {
        write_scaffold_file(&dot_claude.join("settings.json"), CLAUDE_SETTINGS)?;
    }
    if with_git && !dir.join(".git").exists() {
        let _ = crate::services::git_init::init_repo(dir);
        // Give the fresh repo an initial commit so the scaffold (`.claude`, docs,
        // `.gitignore`) is TRACKED, not merely present. This is what makes a later
        // remote `extend` seed the host: git lockstep pairs by transferring
        // *committed* state (`init_pairing` → `reset --hard`), so an unborn HEAD
        // would leave the freshly-paired remote empty and untracked files (like
        // `.claude/settings.json`) never ride the bundle. Only runs for a repo we
        // just created — an imported repo already has `.git`, so its history is
        // never touched.
        git_scaffold_commit(dir);
    }
    Ok(())
}

/// Create one scaffold file unless something — a file, a folder, a symlink,
/// dangling or not — is already at `path`. Returns whether it was written.
///
/// The never-overwrite rule in one place. An imported tree is attacker-controlled
/// and the user's own, so an `exists()`-then-write pair was two holes: a dangling
/// `CLAUDE.md -> ~/somewhere` passed the check and the write then created the
/// link's target outside the project, and a file appearing between the check and
/// the write was truncated. `create_new` + `O_NOFOLLOW` decide in the one open.
fn write_scaffold_file(path: &Path, content: &str) -> std::io::Result<bool> {
    match write_no_follow(path, content.as_bytes(), true) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(e),
    }
}

/// `dir/.claude`, created when absent. `None` when something other than a real
/// folder is already there — a file, or a symlink the tree shipped — and the
/// scaffold then leaves `.claude/settings.json` alone rather than write through
/// it or fail the whole import on it.
fn scaffold_claude_dir(dir: &Path) -> std::io::Result<Option<PathBuf>> {
    let dot_claude = dir.join(".claude");
    match fs::symlink_metadata(&dot_claude) {
        Ok(meta) if meta.is_dir() => Ok(Some(dot_claude)),
        Ok(_) => Ok(None),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&dot_claude)?;
            Ok(Some(dot_claude))
        }
        Err(e) => Err(e),
    }
}

/// `skip_scaffold`'s half of `scaffold_project`: no template files, but a project
/// asked to be git still gets its repo. Deliberately no initial commit — the tree
/// is the user's own files (possibly huge), not a scaffold of ours to stage.
/// Best-effort like `scaffold_project`; callers downgrade the label if no `.git`.
fn init_repo_without_scaffold(dir: &Path, git_type: &str) {
    if git_type != "none" && !dir.join(".git").exists() {
        let _ = crate::services::git_init::init_repo(dir);
    }
}

/// Stage everything the `.gitignore` permits and create a single scaffold commit.
/// Best-effort: staging or the commit failing just leaves HEAD as it was. Respects
/// the user's configured git identity, falling back to a Tabtivity identity only when
/// git can't resolve one (fresh machine, no global `user.name`/`user.email`) so the
/// commit never silently fails for lack of a committer and leaves HEAD unborn.
fn git_scaffold_commit(dir: &Path) {
    // Hardened, hooks off: "extend to remote" seeds this commit in an existing
    // local repo, whose `.git/config` and hooks a fenced agent may have written.
    use crate::commands::git::hookless_git_command_in;
    let _ = hookless_git_command_in(dir, &["add", "-A"]).output();
    const MSG: &str = concat!("Initial ", crate::app_name!(), " scaffold");
    let committed = hookless_git_command_in(dir, &["commit", "-m", MSG])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !committed {
        let _ = hookless_git_command_in(
            dir,
            &[
                "-c",
                concat!("user.name=", crate::app_name!()),
                "-c",
                concat!("user.email=", crate::app_slug!(), "@localhost"),
                "commit",
                "-m",
                MSG,
            ],
        )
        .output();
    }
}

/// True when `dir` is a git repo whose current branch is **unborn** (no commits
/// yet — `rev-parse HEAD` fails). Used to decide whether `extend` must seed an
/// initial commit before lockstep pairing. A missing/erroring git returns `false`
/// (don't force a commit when we can't tell), never a wipe.
fn git_head_unborn(dir: &Path) -> bool {
    crate::paths::command_no_window("git")
        .args(["rev-parse", "--verify", "--quiet", "HEAD"])
        .current_dir(dir)
        .output()
        .map(|o| !o.status.success())
        .unwrap_or(false)
}

/// The `GITIGNORE_DEFAULT` patterns absent from `dir/.gitignore` — a missing
/// file reports every default. Read-only: this is the migration plan's preview
/// of what `ensure_gitignore_defaults` would append.
fn missing_gitignore_lines_at(dir: &Path) -> std::io::Result<Vec<String>> {
    let defaults: Vec<&str> = GITIGNORE_DEFAULT
        .lines()
        .filter(|l| !l.is_empty())
        .collect();
    let path = dir.join(".gitignore");
    if !path.exists() {
        return Ok(defaults.into_iter().map(str::to_string).collect());
    }
    let existing = fs::read_to_string(&path)?;
    let existing_lines: HashSet<&str> = existing.lines().collect();
    Ok(defaults
        .into_iter()
        .filter(|l| !existing_lines.contains(l))
        .map(str::to_string)
        .collect())
}

/// Append any `GITIGNORE_DEFAULT` pattern missing from `dir/.gitignore` to the
/// end of the file, creating it fresh if absent. Existing lines are never
/// reordered or removed — this only ever adds patterns Tabtivity scaffolds by
/// default (e.g. a new one like `project.json` added after the project's
/// `.gitignore` was first written). Returns the patterns that were added.
fn ensure_gitignore_defaults(dir: &Path) -> std::io::Result<Vec<String>> {
    let missing = missing_gitignore_lines_at(dir)?;
    if missing.is_empty() {
        return Ok(vec![]);
    }
    let path = dir.join(".gitignore");
    if !path.exists() {
        fs::write(&path, GITIGNORE_DEFAULT)?;
        return Ok(missing);
    }
    let mut updated = fs::read_to_string(&path)?;
    if !updated.is_empty() && !updated.ends_with('\n') {
        updated.push('\n');
    }
    for line in &missing {
        updated.push_str(line);
        updated.push('\n');
    }
    fs::write(&path, updated)?;
    Ok(missing)
}

/// Make sure `dir/.gitignore` ignores one of Tabtivity's own generated folders
/// (`tabtivity-screenshots/`, `tabtivity-emails/`) before anything is written into it.
///
/// Scaffold repair is the other way these patterns arrive, but it only runs when
/// the user asks for it — so a project scaffolded before the folder existed
/// would take its first saved screenshot or attachment into a tracked path and
/// stage it on the next `git add -A`. The write paths call this instead of
/// trusting that a repair happened.
///
/// Refuses any other folder: this appends to a file the user owns, so the set of
/// patterns it may add is closed. Returns whether a line was added. A project
/// with no `.gitignore` at all gets one holding just this pattern — a full
/// scaffold is `scaffold_project`'s job, not a side effect of saving a file.
pub fn ensure_generated_dir_ignored(dir: &Path, folder: &str) -> std::io::Result<bool> {
    // The old names too: a project that keeps its old folder
    // (`generated_dir_name`) is saved into under that name.
    let ours = [
        SCREENSHOTS_DIR,
        EMAILS_DIR,
        crate::brand::LEGACY_SCREENSHOTS_DIR,
        crate::brand::LEGACY_EMAILS_DIR,
    ];
    if !ours.contains(&folder) {
        return Ok(false);
    }
    let pattern = format!("{folder}/");
    let path = dir.join(".gitignore");
    // A project tree is attacker-controlled (AGENTS.md), and a committed
    // `.gitignore -> ~/.bashrc` would otherwise have this append a line to
    // whatever file the link names. Only a real file, or no file, is ours to
    // touch.
    match fs::symlink_metadata(&path) {
        Ok(meta) if !meta.file_type().is_file() => {
            return Err(std::io::Error::other(".gitignore is not a regular file"));
        }
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            write_no_follow(&path, format!("{pattern}\n").as_bytes(), true)?;
            return Ok(true);
        }
        Err(e) => return Err(e),
    }
    let existing = fs::read_to_string(&path)?;
    if existing.lines().any(|line| line.trim() == pattern) {
        return Ok(false);
    }
    let mut updated = existing;
    if !updated.is_empty() && !updated.ends_with('\n') {
        updated.push('\n');
    }
    updated.push_str(&pattern);
    updated.push('\n');
    write_no_follow(&path, updated.as_bytes(), false)?;
    Ok(true)
}

/// Write `bytes` to `path` without following a symlink at the final component:
/// `create_new` refuses anything already there (a dangling link included), and
/// otherwise `O_NOFOLLOW` refuses a link swapped in after the caller's check.
pub fn write_no_follow(path: &Path, bytes: &[u8], create_new: bool) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = fs::OpenOptions::new();
    options.write(true);
    if create_new {
        options.create_new(true);
    } else {
        options.truncate(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    options.open(path)?.write_all(bytes)
}

/// Result of repairing one project's scaffold — which pieces were actually
/// missing and got filled in, so the caller can report something meaningful
/// instead of a silent no-op.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaffoldRepairReport {
    pub created_files: Vec<String>,
    /// Agent docs that were still an untouched legacy stub and got rewritten to
    /// the current canonical template. Reported separately from `created_files`
    /// because this is the one thing a repair *overwrites*, and the user should
    /// see which file it was.
    pub updated_files: Vec<String>,
    pub gitignore_lines_added: Vec<String>,
    pub git_initialized: bool,
}

impl ScaffoldRepairReport {
    fn is_empty(&self) -> bool {
        self.created_files.is_empty()
            && self.updated_files.is_empty()
            && self.gitignore_lines_added.is_empty()
            && !self.git_initialized
    }
}

/// The stubs the agent docs used to be scaffolded with, before `AGENTS.md`
/// became the canonical file and `CLAUDE.md`/`GEMINI.md` became pointers to it.
/// A repair upgrades an agent doc whose content is still byte-identical to its
/// legacy stub (or empty): that text is provably untouched, so replacing it
/// loses nothing. Anything a user or an agent actually wrote fails the match and
/// is left alone — the never-overwrite rule still holds for every other file.
const LEGACY_AGENT_STUBS: &[(&str, &str)] = &[
    ("AGENTS.md", "# Agents\n"),
    ("CLAUDE.md", "# Claude Context\n"),
    ("GEMINI.md", "# Gemini Context\n"),
];

/// Every earlier `AGENTS_SCAFFOLD`, byte for byte, oldest first (2026-08-26 to
/// 2026-09-28). A project scaffolded with one of them still holds that text
/// until someone edits it, and only this list lets a repair tell such an
/// untouched copy from the user's own words: the never-overwrite rule meant
/// the 09-05 copy kept telling agents the outbox takes images only.
const AGENTS_HISTORY: &[&str] = &[
    include_str!("scaffold_history/AGENTS.2026-08-26.md"),
    include_str!("scaffold_history/AGENTS.2026-08-30.md"),
    include_str!("scaffold_history/AGENTS.2026-09-05.md"),
    include_str!("scaffold_history/AGENTS.2026-09-14.md"),
    include_str!("scaffold_history/AGENTS.2026-09-28.md"),
];

/// True when `content` is the untouched legacy stub for the agent doc `name`
/// (or empty), or an untouched earlier `AGENTS.md` template. Line endings are
/// ignored — a checkout may have turned them to CRLF. Pure, so the upgrade rule
/// is unit-testable without touching disk.
fn is_legacy_agent_stub(name: &str, content: &str) -> bool {
    let Some((_, stub)) = LEGACY_AGENT_STUBS.iter().find(|(n, _)| *n == name) else {
        return false;
    };
    if content.trim().is_empty() || content.trim() == stub.trim() {
        return true;
    }
    let content = content.replace("\r\n", "\n");
    name == "AGENTS.md" && AGENTS_HISTORY.contains(&content.as_str())
}

/// Like `scaffold_project`, but for an **already-scaffolded** project whose
/// scaffold has drifted behind current defaults (e.g. it predates a scaffold
/// file or a `.gitignore` pattern being added). Fills in whatever is missing —
/// same never-overwrite rule for existing files — and additionally merges any
/// missing `GITIGNORE_DEFAULT` pattern into an already-present `.gitignore`
/// (plain `scaffold_project` leaves a pre-existing `.gitignore` untouched).
fn repair_project_scaffold_at(dir: &Path, with_git: bool) -> std::io::Result<ScaffoldRepairReport> {
    fs::create_dir_all(dir)?;

    let mut report = ScaffoldRepairReport::default();
    for (name, content) in SCAFFOLD_FILES {
        let p = dir.join(name);
        if write_scaffold_file(&p, content)? {
            report.created_files.push((*name).to_string());
            continue;
        }
        // Only an agent doc still holding its untouched legacy stub is rewritten.
        let Ok(existing) = fs::read_to_string(&p) else {
            continue;
        };
        if existing != *content && is_legacy_agent_stub(name, &existing) {
            write_no_follow(&p, content.as_bytes(), false)?;
            report.updated_files.push((*name).to_string());
        }
    }
    if with_git {
        report.gitignore_lines_added = ensure_gitignore_defaults(dir)?;
    }

    if let Some(dot_claude) = scaffold_claude_dir(dir)? {
        if write_scaffold_file(&dot_claude.join("settings.json"), CLAUDE_SETTINGS)? {
            report
                .created_files
                .push(".claude/settings.json".to_string());
        }
    }
    if with_git && !dir.join(".git").exists() {
        let _ = crate::services::git_init::init_repo(dir);
        // `.exists()`, not `is_dir()` (#23 I6): `.git` is a directory for a main repo
        // and a *file* in a linked worktree, so `is_dir` reported a worktree-rooted
        // project as having no repo at all.
        report.git_initialized = dir.join(".git").exists();
    }
    Ok(report)
}

/// Resolve the local, on-disk directory a project's scaffold lives in: the
/// project's own `directory` for a local project, or its local `mirror`
/// working copy for a mount-free remote project (the remote host tree is
/// never touched here — see `finish_import`/`create_project`). `None` when
/// there is no local target to repair (e.g. a remote project with no mirror
/// recorded yet).
fn scaffold_target_for_entry(entry: &ProjectEntry) -> Option<(PathBuf, bool)> {
    let git_type = entry
        .extra
        .get("git_type")
        .and_then(Value::as_str)
        .unwrap_or("local");
    let with_git = git_type != "none";
    let target = if entry_is_remote(entry) {
        entry_mirror(entry)?
    } else {
        entry_directory(entry)?
    };
    Some((PathBuf::from(target), with_git))
}

/// Whether a materialized scaffold target needs repair. Kept separate from the
/// Tauri command so the exact warning rule can be covered without depending on
/// the user's persisted project list.
fn scaffold_is_missing_at(target: &Path, with_git: bool) -> bool {
    SCAFFOLD_FILES.iter().any(|(name, _)| {
        let p = target.join(name);
        // An agent doc still holding its untouched legacy stub counts as
        // missing: a repair would change it, so the tag must not claim the
        // scaffold is complete (see `is_legacy_agent_stub`).
        match fs::read_to_string(&p) {
            Ok(existing) => is_legacy_agent_stub(name, &existing),
            Err(_) => !p.exists(),
        }
    }) || (with_git && !target.join(".gitignore").exists())
        || !target.join(".claude/settings.json").exists()
}

/// A single project's scaffold-repair outcome, for the "Repair scaffold
/// files" UI action (per-project or bulk across all managed projects).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectScaffoldRepair {
    pub project_id: String,
    pub name: String,
    pub target_dir: String,
    pub report: ScaffoldRepairReport,
}

/// Repair one project's scaffold: fill in any scaffold doc, `.gitignore`
/// pattern, or `.claude/settings.json` that is missing relative to current
/// defaults. Safe to run repeatedly — every step is additive/idempotent.
#[tauri::command]
pub fn repair_project_scaffold(project_id: String) -> Result<ProjectScaffoldRepair, String> {
    let list_path = storage::state_dir().join("projects.json");
    let list: ProjectsList = storage::read_json(&list_path).map_err(|e| e.to_string())?;
    let entry = list
        .into_iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "Project not found".to_string())?;
    let (target, with_git) = scaffold_target_for_entry(&entry)
        .ok_or_else(|| "Project has no local scaffold target".to_string())?;
    let report = repair_project_scaffold_at(&target, with_git).map_err(|e| e.to_string())?;
    Ok(ProjectScaffoldRepair {
        project_id: entry.id,
        name: entry.name,
        target_dir: target.to_string_lossy().to_string(),
        report,
    })
}

/// Repair scaffold files across every managed project in one pass — the bulk
/// counterpart to `repair_project_scaffold`. Projects whose local target
/// directory doesn't exist yet (e.g. a remote project whose mirror hasn't
/// materialized) are silently skipped rather than erroring the whole batch.
/// Returns only the projects that actually needed a repair.
#[tauri::command]
pub fn repair_all_project_scaffolds() -> Result<Vec<ProjectScaffoldRepair>, String> {
    let list_path = storage::state_dir().join("projects.json");
    if !list_path.exists() {
        return Ok(vec![]);
    }
    let list: ProjectsList = storage::read_json(&list_path).map_err(|e| e.to_string())?;
    let mut results = Vec::new();
    for entry in &list {
        let Some((target, with_git)) = scaffold_target_for_entry(entry) else {
            continue;
        };
        if !target.is_dir() {
            continue;
        }
        match repair_project_scaffold_at(&target, with_git) {
            Ok(report) if !report.is_empty() => results.push(ProjectScaffoldRepair {
                project_id: entry.id.clone(),
                name: entry.name.clone(),
                target_dir: target.to_string_lossy().to_string(),
                report,
            }),
            Ok(_) => {}
            Err(e) => eprintln!(
                "repair_all_project_scaffolds: '{}' ({}) failed: {e}",
                entry.name, entry.id
            ),
        }
    }
    Ok(results)
}

/// One-time-per-entry startup migration that brings legacy `projects.json`
/// entries fully in line with the current Tabtivity version. For each entry:
///
/// 1. `normalize_entry` canonicalizes its shape (backfill `directory`, map
///    legacy `git_type`). Entries it touches are *legacy* — written by an older
///    Tabtivity that predates those fields.
/// 2. Every legacy entry additionally gets its on-disk scaffold refreshed (the
///    same additive, never-overwrite repair as the manual "Repair scaffold
///    files" action), since a legacy project also predates current scaffold
///    defaults (`.claude/settings.json`, newer docs, `.gitignore` patterns).
///
/// The normalized list is persisted once if anything changed, so the migration
/// is durable rather than re-derived on every load. Runs best-effort at startup
/// off the UI thread; every failure is logged and non-fatal.
pub fn migrate_legacy_projects() {
    let path = storage::state_dir().join("projects.json");
    if !path.exists() {
        return;
    }
    let repairs = match patch_projects_list(|list| {
        let mut repairs = Vec::new();
        for entry in list.iter_mut() {
            if !normalize_entry(entry) {
                continue;
            }
            if let Some((target, with_git)) = scaffold_target_for_entry(entry) {
                repairs.push((entry.name.clone(), entry.id.clone(), target, with_git));
            }
        }
        Ok(repairs)
    }) {
        Ok(repairs) => repairs,
        Err(e) => {
            eprintln!("migrate_legacy_projects: read projects.json: {e}");
            return;
        }
    };
    for (name, id, target, with_git) in repairs {
        // Legacy entry: also fill in any scaffold piece it predates. Skipped
        // when there's no materialized local target yet (e.g. a remote project
        // whose mirror hasn't been created).
        if !target.is_dir() {
            continue;
        }
        match repair_project_scaffold_at(&target, with_git) {
            Ok(report) if !report.is_empty() => eprintln!(
                "migrate_legacy_projects: '{}' ({}) scaffold repaired: {:?}",
                name, id, report.created_files
            ),
            Ok(_) => {}
            Err(e) => eprintln!(
                "migrate_legacy_projects: '{}' ({}) scaffold repair failed: {e}",
                name, id
            ),
        }
    }
}

fn scaffold_preview(dir: &Path) -> Vec<ScaffoldPreviewItem> {
    // Anything at the path counts — a dangling symlink too — because that is
    // what `write_scaffold_file` keeps; `exists()` would call such a link
    // missing and promise a file the import then doesn't write.
    let present = |rel: &str| fs::symlink_metadata(dir.join(rel)).is_ok();
    let mut items = SCAFFOLD_FILES
        .iter()
        .map(|(name, _)| ScaffoldPreviewItem {
            path: (*name).to_string(),
            exists: present(name),
            kind: "file".to_string(),
        })
        .collect::<Vec<_>>();

    items.push(ScaffoldPreviewItem {
        path: ".gitignore".to_string(),
        exists: present(".gitignore"),
        kind: "file".to_string(),
    });
    items.push(ScaffoldPreviewItem {
        path: ".git".to_string(),
        // `.exists()`, not `is_dir()` (#23 I6): in a linked worktree `.git` is a file.
        // Reporting it **Missing** there invited a `git init` that would nest a second
        // repository inside somebody else's worktree.
        exists: dir.join(".git").exists(),
        kind: "directory".to_string(),
    });
    items.push(ScaffoldPreviewItem {
        path: ".claude/settings.json".to_string(),
        exists: present(".claude/settings.json"),
        kind: "file".to_string(),
    });
    items
}

#[tauri::command]
pub fn preview_project_scaffold(source_dir: String) -> Result<Vec<ScaffoldPreviewItem>, String> {
    let source = PathBuf::from(source_dir);
    if !source.is_dir() {
        return Err("Source folder does not exist".to_string());
    }
    Ok(scaffold_preview(&source))
}

/// True when a project is missing one or more scaffold pieces (any scaffold
/// doc, `.claude/settings.json`, or — for git-backed projects only —
/// `.gitignore`) — drives the "no scaffold" tag in the pill hover overlay.
/// `.gitignore` is a git-axis artifact, so it is not required of `git_type:
/// "none"` projects (which never get one written, see `scaffold_project`).
/// `.git` is likewise excluded: git presence is the separate `git_type` axis. A
/// project with no materialized local scaffold target yet (e.g. a remote project
/// whose mirror hasn't been created) reports `false` rather than a spurious
/// "missing".
#[tauri::command]
pub fn project_scaffold_missing(project_id: String) -> Result<bool, String> {
    let list_path = storage::state_dir().join("projects.json");
    if !list_path.exists() {
        return Ok(false);
    }
    let list: ProjectsList = storage::read_json(&list_path).map_err(|e| e.to_string())?;
    let Some(entry) = list.into_iter().find(|p| p.id == project_id) else {
        return Ok(false);
    };
    let Some((target, with_git)) = scaffold_target_for_entry(&entry) else {
        return Ok(false);
    };
    if !target.is_dir() {
        return Ok(false);
    }
    Ok(scaffold_is_missing_at(&target, with_git))
}

// ── Step-by-step project migration ─────────────────────────────────────────

/// One proposed change of the "Migrate project" flow. The dialog renders each
/// step with what it would do and the user accepts or declines it; `id` is what
/// an accepting `project_migration_apply` call echoes back. Kinds:
/// `entry` (normalize the projects.json entry), `createFile`, `upgradeStub`,
/// `gitignore`, `gitInit`.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationStep {
    pub id: String,
    pub kind: String,
    /// The project-relative file the step touches, when it touches one.
    pub path: Option<String>,
    /// Human-readable specifics (gitignore patterns to append, entry fields
    /// that change) — data, not prose: the frontend owns the wording.
    pub details: Vec<String>,
}

/// The dry-run answer to "what would migrating this project change" — a list
/// the user reviews step by step. Empty `steps` means already up to date.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationPlan {
    pub project_id: String,
    pub name: String,
    /// The local dir scaffold steps would run in; `None` when no local target
    /// has materialized yet (then only the `entry` step can be offered).
    pub target_dir: Option<String>,
    pub steps: Vec<MigrationStep>,
}

/// What one apply actually changed. `report` reuses the repair shape so the
/// summary code is shared with "Repair scaffold files".
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationApplyReport {
    pub entry_normalized: bool,
    pub report: ScaffoldRepairReport,
}

/// What `normalize_entry` would change on this entry, as `field: old → new`
/// lines — computed by running the real normalizer on a clone and diffing, so
/// the preview can never drift from what an accepted `entry` step applies.
fn entry_migration_details(entry: &ProjectEntry) -> Vec<String> {
    let mut probe = entry.clone();
    if !normalize_entry(&mut probe) {
        return vec![];
    }
    let mut details = Vec::new();
    for key in ["directory", "git_type"] {
        let before = entry.extra.get(key).and_then(Value::as_str);
        let after = probe.extra.get(key).and_then(Value::as_str);
        if before != after {
            details.push(match before {
                Some(b) => format!("{key}: {b} → {}", after.unwrap_or("")),
                None => format!("{key} → {}", after.unwrap_or("")),
            });
        }
    }
    details
}

/// The scaffold-side migration steps for one materialized target dir — the
/// same conditions `repair_project_scaffold_at` acts on, read-only and one
/// step per piece so each can be accepted or declined on its own.
fn migration_steps_at(dir: &Path, with_git: bool) -> std::io::Result<Vec<MigrationStep>> {
    let mut steps = Vec::new();
    for (name, content) in SCAFFOLD_FILES {
        let p = dir.join(name);
        match fs::read_to_string(&p) {
            Ok(existing) => {
                if existing != *content && is_legacy_agent_stub(name, &existing) {
                    steps.push(MigrationStep {
                        id: format!("stub:{name}"),
                        kind: "upgradeStub".to_string(),
                        path: Some((*name).to_string()),
                        details: vec![],
                    });
                }
            }
            Err(_) => {
                if !p.exists() {
                    steps.push(MigrationStep {
                        id: format!("file:{name}"),
                        kind: "createFile".to_string(),
                        path: Some((*name).to_string()),
                        details: vec![],
                    });
                }
            }
        }
    }
    if !dir.join(".claude/settings.json").exists() {
        steps.push(MigrationStep {
            id: "claude_settings".to_string(),
            kind: "createFile".to_string(),
            path: Some(".claude/settings.json".to_string()),
            details: vec![],
        });
    }
    if with_git {
        let missing = missing_gitignore_lines_at(dir)?;
        if !missing.is_empty() {
            steps.push(MigrationStep {
                id: "gitignore".to_string(),
                kind: "gitignore".to_string(),
                path: Some(".gitignore".to_string()),
                details: missing,
            });
        }
        // `.exists()`, not `is_dir()`: a linked worktree's `.git` is a file
        // (#23 I6) and must not invite a nested `git init`.
        if !dir.join(".git").exists() {
            steps.push(MigrationStep {
                id: "git_init".to_string(),
                kind: "gitInit".to_string(),
                path: None,
                details: vec![],
            });
        }
    }
    Ok(steps)
}

/// Apply the **accepted** scaffold steps only. Every condition is re-checked
/// against the disk (the plan is a snapshot and the tree can move under it),
/// so a stale accept degrades to a no-op rather than an overwrite — the
/// never-overwrite rule of `repair_project_scaffold_at` holds per step.
fn apply_migration_steps_at(
    dir: &Path,
    with_git: bool,
    accepted: &HashSet<String>,
) -> std::io::Result<ScaffoldRepairReport> {
    fs::create_dir_all(dir)?;
    let mut report = ScaffoldRepairReport::default();
    for (name, content) in SCAFFOLD_FILES {
        let p = dir.join(name);
        if accepted.contains(&format!("file:{name}")) {
            if write_scaffold_file(&p, content)? {
                report.created_files.push((*name).to_string());
            }
        } else if accepted.contains(&format!("stub:{name}")) {
            if let Ok(existing) = fs::read_to_string(&p) {
                if existing != *content && is_legacy_agent_stub(name, &existing) {
                    write_no_follow(&p, content.as_bytes(), false)?;
                    report.updated_files.push((*name).to_string());
                }
            }
        }
    }
    if accepted.contains("claude_settings") {
        if let Some(dot_claude) = scaffold_claude_dir(dir)? {
            if write_scaffold_file(&dot_claude.join("settings.json"), CLAUDE_SETTINGS)? {
                report
                    .created_files
                    .push(".claude/settings.json".to_string());
            }
        }
    }
    if with_git && accepted.contains("gitignore") {
        report.gitignore_lines_added = ensure_gitignore_defaults(dir)?;
    }
    if with_git && accepted.contains("git_init") && !dir.join(".git").exists() {
        let _ = crate::services::git_init::init_repo(dir);
        report.git_initialized = dir.join(".git").exists();
    }
    Ok(report)
}

/// Dry-run for the "Migrate project" dialog: everything an old project is
/// missing relative to the current Tabtivity state, one step per piece. Changes
/// nothing.
#[tauri::command]
pub fn project_migration_plan(project_id: String) -> Result<MigrationPlan, String> {
    let list_path = storage::state_dir().join("projects.json");
    let list: ProjectsList = storage::read_json(&list_path).map_err(|e| e.to_string())?;
    let entry = list
        .into_iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "Project not found".to_string())?;
    let mut steps = Vec::new();
    let entry_details = entry_migration_details(&entry);
    if !entry_details.is_empty() {
        steps.push(MigrationStep {
            id: "entry".to_string(),
            kind: "entry".to_string(),
            path: None,
            details: entry_details,
        });
    }
    let mut target_dir = None;
    if let Some((target, with_git)) = scaffold_target_for_entry(&entry) {
        if target.is_dir() {
            steps.extend(migration_steps_at(&target, with_git).map_err(|e| e.to_string())?);
            target_dir = Some(target.to_string_lossy().to_string());
        }
    }
    Ok(MigrationPlan {
        project_id: entry.id,
        name: entry.name,
        target_dir,
        steps,
    })
}

/// Apply the steps the user accepted (by id, from `project_migration_plan`).
/// Declined steps are simply absent from `accepted` and nothing runs for them.
#[tauri::command]
pub fn project_migration_apply(
    project_id: String,
    accepted: Vec<String>,
) -> Result<MigrationApplyReport, String> {
    let accepted: HashSet<String> = accepted.into_iter().collect();
    let mut entry_normalized = false;
    if accepted.contains("entry") {
        entry_normalized = patch_projects_list(|list| {
            let entry = list
                .iter_mut()
                .find(|p| p.id == project_id)
                .ok_or_else(|| "Project not found".to_string())?;
            Ok(normalize_entry(entry))
        })?;
    }
    // Re-read after the entry step: normalization can backfill the very
    // `directory` the scaffold target resolves from.
    let list_path = storage::state_dir().join("projects.json");
    let list: ProjectsList = storage::read_json(&list_path).map_err(|e| e.to_string())?;
    let entry = list
        .into_iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "Project not found".to_string())?;
    let mut report = ScaffoldRepairReport::default();
    if let Some((target, with_git)) = scaffold_target_for_entry(&entry) {
        if target.is_dir() {
            report =
                apply_migration_steps_at(&target, with_git, &accepted).map_err(|e| e.to_string())?;
        }
    }
    Ok(MigrationApplyReport {
        entry_normalized,
        report,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectRequest {
    pub name: String,
    pub directory: String,
    pub description: Option<String>,
    pub git_type: Option<String>,
    /// Which hosting service a `remote-*` project is pushed to ("github" /
    /// "gitlab"), when the creation already knows — a clone/fork import reads it
    /// off the repository URL. Ignored for any other `git_type`.
    #[serde(default)]
    pub git_provider: Option<String>,
    /// Skip writing the Tabtivity scaffold (and `git init`) — for new projects
    /// that should start empty. `project.json` is still created so the project
    /// registers normally.
    #[serde(default)]
    pub skip_scaffold: bool,
    /// When present the project is remote: `directory` is ignored and the
    /// project root becomes the local sshfs mountpoint for `remote`.
    #[serde(default)]
    pub remote: Option<RemoteSpec>,
    /// Remote projects only: the user-chosen parent directory for the local
    /// mirror (the dialog's "Local location"). The mirror lands at
    /// `<mirror_parent>/<name>`. Absent → the default `projects-ssh` root.
    #[serde(default)]
    pub mirror_parent: Option<String>,
    /// When present (and enabled), the project is a **VM project**
    /// (`docs/vm_projects_plan.md`): the whole tree lives inside a locally
    /// booted QEMU/KVM guest, and a `remote` spec pointing at the VM's
    /// forwarded loopback port is synthesized here — the caller never supplies
    /// one. Chosen at creation only (the boundary is a data move, not a
    /// toggle). Mutually exclusive with `remote`.
    #[serde(default)]
    pub vm: Option<crate::schema::project::VmSpec>,
}

#[tauri::command]
pub async fn create_project(req: CreateProjectRequest) -> Result<ProjectEntry, String> {
    run_off_thread(move || create_project_blocking(req)).await
}

pub fn create_project_blocking(mut req: CreateProjectRequest) -> Result<ProjectEntry, String> {
    let id = uuid_v4();

    // A VM project IS a remote project (the one architectural decision of
    // `docs/vm_projects_plan.md`): synthesize its RemoteSpec here. Host and
    // port are placeholders until the first boot rewrites them
    // (`services::vm::record_vm_endpoint`); `key_auth`/`auto_connect` are by
    // construction — the per-VM keypair authenticates, and boot-on-activate
    // rides the ordinary armed auto-connect path with no prompt possible.
    let is_vm = req.vm.as_ref().is_some_and(|v| v.enabled);
    if is_vm {
        if req.remote.is_some() {
            return Err("a VM project cannot also have an SSH remote".to_string());
        }
        req.remote = Some(RemoteSpec {
            user: Some(crate::services::vm::VM_USER.to_string()),
            host: "127.0.0.1".to_string(),
            port: None,
            remote_path: crate::services::vm::VM_PROJECT_DIR.to_string(),
            openvpn: None,
            auto_connect: Some(true),
            key_auth: Some(true),
            persist_sessions: None,
            vm: Some(true),
            label: Some("VM".to_string()),
            extra: HashMap::new(),
        });
    }

    // Refuse a site another project already owns — BEFORE any of the filesystem
    // work below (a remote `mkdir`, a scaffold, a `git init`). "New project"
    // pointed at a folder that is already a project used to register a second
    // entry straight over the first, and scaffold it while it was at it.
    let registered = read_projects_list()?;
    // VM projects are exempt from the duplicate gate: every one synthesizes
    // the same loopback target + in-guest path, but each names its own,
    // freshly created virtual machine — the site can never collide.
    if !is_vm {
        let site = match req.remote.as_ref() {
            Some(spec) => ProjectSite::Remote { spec },
            None => ProjectSite::Local {
                dir: &req.directory,
            },
        };
        if let Some(conflict) = find_project_conflict(&registered, &site, None) {
            return Err(conflict_message(&conflict));
        }
    }

    // A new local project gets a folder of its own (`claim_new_project_dir`),
    // claimed before anything is written. Should creation fail after that, the
    // folder — holding nothing but what this call put there — is removed again,
    // so a retry isn't refused by the remains of the failed attempt.
    let claimed = match req.remote {
        None => {
            let dir = PathBuf::from(&req.directory);
            claim_new_project_dir(&dir)?;
            Some(dir)
        }
        Some(_) => None,
    };
    let created = create_claimed_project(req, id, &registered, is_vm);
    if created.is_err() {
        if let Some(dir) = claimed {
            let _ = fs::remove_dir_all(&dir);
        }
    }
    created
}

/// `create_project_blocking` past its gates: the site is free and, for a local
/// project, its folder was just created empty by `claim_new_project_dir`.
fn create_claimed_project(
    req: CreateProjectRequest,
    id: String,
    registered: &ProjectsList,
    is_vm: bool,
) -> Result<ProjectEntry, String> {
    // Mount-free remote: a remote project's `directory` is a LOCAL per-project
    // state dir that holds its `project.json` (tabs/time/etc.); the project's
    // actual tree lives on the host at `remote.remote_path` and is reached over
    // SFTP/SSH. Best-effort create that remote root so agent tabs / git can `cd`
    // into it (key/agent auth — a password-auth host may need it to pre-exist).
    // Local projects use the chosen directory unchanged.
    let dir = match req.remote.as_ref() {
        Some(remote) => {
            // A VM project's host doesn't exist yet — its project dir is
            // created by cloud-init at first boot, so there is nothing to
            // mkdir over SSH here.
            if !is_vm {
                if let Err(e) = crate::services::ssh_exec::remote_mkdir_p(remote) {
                    eprintln!(
                        "create_project: remote mkdir '{}' failed (create it on the host if needed): {e}",
                        remote.remote_path
                    );
                }
            }
            remote_project_state_dir(&id)
        }
        None => PathBuf::from(&req.directory),
    };
    let directory = dir.to_string_lossy().to_string();

    let mut git_type = normalize_git_type(req.git_type.as_deref().unwrap_or("local"));

    // Remote projects mirror into `<name>` under the chosen "Local location"
    // (`mirror_parent`), defaulting to the top-level `tabtivity/projects-ssh/` root;
    // relocatable later. None for local projects — and None for VM projects,
    // whose sync posture is the *inverse* of a network remote's
    // (`docs/vm_projects_plan.md`, "Sync posture"): remote-only by default,
    // zero agent-written bytes on the host, a mirror only ever by explicit
    // later opt-in.
    let mirror = if is_vm {
        None
    } else {
        req.remote.as_ref().map(|_| {
            resolve_remote_mirror(req.mirror_parent.as_deref(), &req.name, &id, registered)
        })
    };

    // A remote project's local `directory` only holds project.json (created
    // below); its scaffold belongs in the local **mirror** twin — the working
    // copy the user edits and local-on-remote tabs cwd into. Bytes reach the
    // host only on an explicit manual push (SSH-sync is PULL-only / no-clobber),
    // so scaffolding the mirror is safe and never touches the host tree here.
    if req.remote.is_some() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        // Every remote project has an always-present local mirror twin, created
        // up front so a local-on-remote tab can cwd into it immediately. Scaffold
        // it like a local project (honoring skip_scaffold); manual sync pushes it.
        if let Some(mirror) = &mirror {
            let mirror_dir = Path::new(mirror);
            if req.skip_scaffold {
                let _ = std::fs::create_dir_all(mirror_dir);
            } else {
                scaffold_project(mirror_dir, git_type != "none").map_err(|e| e.to_string())?;
            }
        }
    } else if !req.skip_scaffold {
        scaffold_project(&dir, git_type != "none").map_err(|e| e.to_string())?;
    } else {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        if !is_vm {
            init_repo_without_scaffold(&dir, &git_type);
        }
    }

    // The git label must reflect reality. `scaffold_project`'s `git init` is
    // best-effort (its exit status is swallowed), so a project can be scaffolded
    // with `git_type` `local`/`remote-*` while no repo actually got created (git
    // missing, permission denied, a read-only tree). Mirror the remote branch of
    // `finish_import`: if git was requested but no `.git` exists after scaffolding,
    // downgrade to `none` rather than label the project git — least of all
    // `remote-private`, whose pill shows a hosting badge — with no repo on disk.
    // `.exists()` (not `is_dir`) is deliberate: `.git` is a *file* in a linked
    // worktree. A local `skip_scaffold` skips the template files but still inits
    // the repo, so it is checked the same way; a remote one leaves its mirror
    // repo-less on purpose (lockstep below keys off that), so it is left untouched.
    // …except a VM project, which has no local tree at all to check — its repo
    // materializes inside the guest (the in-VM clone, or a `git init` there).
    if git_type != "none" && !is_vm && !(req.skip_scaffold && req.remote.is_some()) {
        let git_target = mirror.as_deref().map(Path::new).unwrap_or(dir.as_path());
        if !git_target.join(".git").exists() {
            eprintln!(
                "create_project: git init in '{}' failed; recording git_type=none so the \
                 project is not labeled git (or remote-private) without a repo",
                git_target.display()
            );
            git_type = "none".to_string();
        }
    }

    let now = chrono_now();
    let description = clean_description(req.description);
    // Resolved after the downgrade above, so a project whose `git init` failed
    // never carries a hosting provider for a repo it doesn't have.
    let git_provider = normalize_git_provider(req.git_provider.as_deref(), &git_type);

    let project = Project {
        id: id.clone(),
        name: req.name.clone(),
        directory: directory.clone(),
        description: description.clone(),
        git_type: Some(git_type.clone()),
        git_provider: git_provider.clone(),
        created_at: Some(now),
        remote: req.remote.clone(),
        mirror: mirror.clone(),
        vm: req.vm.clone(),
        ..Default::default()
    };

    let project_file = dir.join("project.json");
    storage::write_json(&project_file, &project).map_err(|e| e.to_string())?;

    // Register in the global list.
    let mut extra = project_extra(
        directory.clone(),
        git_type,
        git_provider,
        description,
        req.remote.as_ref(),
        mirror.as_deref(),
    );
    // Mirror the VM spec into the pill-list entry (like `remote`/`sandbox`) —
    // the always-local copy `services::vm` trusts.
    if let Some(vm_spec) = req.vm.as_ref().filter(|v| v.enabled) {
        if let Ok(value) = serde_json::to_value(vm_spec) {
            extra.insert("vm".to_string(), value);
        }
    }

    let entry = patch_projects_list(|list| {
        if !is_vm {
            let site = match req.remote.as_ref() {
                Some(spec) => ProjectSite::Remote { spec },
                None => ProjectSite::Local {
                    dir: &req.directory,
                },
            };
            if let Some(conflict) = find_project_conflict(list, &site, None) {
                return Err(conflict_message(&conflict));
            }
        }
        let entry = ProjectEntry {
            id: id.clone(),
            name: req.name.clone(),
            status: "inactive".to_string(),
            position: next_position(list),
            local_file: project_file.to_string_lossy().to_string(),
            extra,
        };
        list.push(entry.clone());
        Ok(entry)
    })?;

    // Lockstep on by default for a git-backed remote project — the same call
    // `extend_project_to_remote` makes, for the same reason: the host root was
    // just created (empty), and the mirror was scaffolded with an initial commit,
    // so the first pass can only be a one-directional seed, never a divergence.
    // If the user instead pointed at a host dir that already holds differing
    // files, pairing refuses and asks (`pairing_conflict`) rather than clobbering.
    //
    // Gated on the mirror *actually* being a repo rather than on `git_type` alone:
    // `skip_scaffold` creates the mirror without `git init`, and lockstep on a
    // repo-less mirror has no history to seed from. Best-effort — a write failure
    // just leaves lockstep off (its default), never fails project creation.
    if let Some(mirror) = mirror.as_deref() {
        // `is_dir()` here is DELIBERATE, unlike the two `.exists()` fixes above (#23 I6):
        // a mirror whose `.git` is a *file* is a linked worktree, and lockstep against a
        // worktree would `reset --hard` a branch backed by an object store the parent
        // and every sibling worktree share. Staying off is the right outcome; this
        // comment is so the next reader knows it is the intended one.
        if Path::new(mirror).join(".git").is_dir() {
            let state = crate::services::git_peer::GitPeerState {
                enabled: true,
                ..Default::default()
            };
            if let Err(e) = crate::services::git_peer::save_state(&id, &state) {
                eprintln!(
                    "create_project: could not enable lockstep for '{id}' \
                     (leaving it off; user can toggle it on): {e}"
                );
            }
        }
    }

    Ok(entry)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProjectRequest {
    pub source_dir: String,
    pub name: String,
    pub description: Option<String>,
    pub git_type: Option<String>,
    /// Which hosting service a `remote-*` project is pushed to ("github" /
    /// "gitlab") — the import dialog fills it from the clone/fork URL, so a
    /// cloned repo carries its host without waiting for the origin sniff.
    #[serde(default)]
    pub git_provider: Option<String>,
    pub mode: String,
    pub scaffold_fill_modes: Option<HashMap<String, String>>,
    pub manual_validation_confirmed: Option<bool>,
    /// Skip writing the Tabtivity scaffold files — for importing projects that
    /// already carry their own. A git `git_type` still gets its repo (no initial
    /// commit), and `project.json` is still created/updated so the project
    /// registers normally.
    #[serde(default)]
    pub skip_scaffold: bool,
    /// When present the project is remote: `source_dir` is the already-mounted
    /// remote directory and the only supported `mode` is "keep".
    #[serde(default)]
    pub remote: Option<RemoteSpec>,
    /// Remote imports only: the user-chosen parent directory for the local
    /// mirror (the dialog's "Local location"). The mirror lands at
    /// `<mirror_parent>/<name>`. Absent → the default `projects-ssh` root.
    #[serde(default)]
    pub mirror_parent: Option<String>,
}

#[tauri::command]
pub async fn import_project(req: ImportProjectRequest) -> Result<ProjectEntry, String> {
    run_off_thread(move || import_project_blocking(req)).await
}

pub fn import_project_blocking(req: ImportProjectRequest) -> Result<ProjectEntry, String> {
    if req.name.trim().is_empty() {
        return Err("Project name is invalid".to_string());
    }

    let id = uuid_v4();

    // Refuse a site another project already owns, BEFORE the mode dispatch below
    // moves or copies anything. Ordering is the whole point: the move used to run
    // first and `finish_import` checked only the *destination*, so re-importing a
    // registered folder under a different name moved the tree out from under the
    // original entry and left it pointing at a path that no longer existed.
    //
    // `copy` is deliberately exempt: it duplicates the tree into a new directory
    // and leaves the source registered and intact, so the result is a genuinely
    // separate project — "start a variant from this one" is a real thing to want.
    // `keep` and `move` both end up on the source tree itself.
    let registered = read_projects_list()?;
    if req.mode != "copy" {
        let site = match req.remote.as_ref() {
            Some(spec) => ProjectSite::Remote { spec },
            None => ProjectSite::Local {
                dir: &req.source_dir,
            },
        };
        if let Some(conflict) = find_project_conflict(&registered, &site, None) {
            return Err(conflict_message(&conflict));
        }
    }

    if let Some(remote) = req.remote.clone() {
        if req.mode != "keep" {
            return Err(
                "Remote imports must use 'keep' mode (copy/move are not supported)".to_string(),
            );
        }
        // Mount-free: the user browsed to an existing remote directory, so there
        // is nothing to create on the host. The project's `directory` is a LOCAL
        // per-project state dir that holds its project.json; the tree stays on the
        // host (`remote.remote_path`) and is reached over SFTP/SSH.
        let local = remote_project_state_dir(&id);
        std::fs::create_dir_all(&local).map_err(|e| e.to_string())?;
        return finish_import(req, id, local, Some(remote));
    }

    let source = PathBuf::from(&req.source_dir);
    if !source.is_dir() {
        return Err("Source folder does not exist".to_string());
    }

    if matches!(req.mode.as_str(), "copy" | "move") && req.manual_validation_confirmed != Some(true)
    {
        return Err("Copy and move imports require manual validation".to_string());
    }

    let target = match req.mode.as_str() {
        "keep" => source,
        "copy" | "move" => {
            let safe = sanitize_name(&req.name);
            if safe.is_empty() {
                return Err("Project name is invalid".to_string());
            }
            let dest = projects_root().join(safe);
            if dest.exists() {
                return Err(format!("Destination '{}' already exists", dest.display()));
            }
            if req.mode == "copy" {
                copy_dir_all(&source, &dest)?;
            } else {
                fs::create_dir_all(projects_root()).map_err(|e| e.to_string())?;
                // A plain rename fails across drives/filesystems (EXDEV on Unix,
                // ERROR_NOT_SAME_DEVICE on Windows). Fall back to copy-then-remove
                // for that case only; `dest` was checked absent above, so any other
                // failure is reported rather than turned into a duplicate tree.
                match fs::rename(&source, &dest) {
                    Ok(()) => {}
                    Err(e) if crate::paths::is_cross_device(&e) => {
                        copy_dir_all(&source, &dest)?;
                        fs::remove_dir_all(&source).map_err(|e| e.to_string())?;
                    }
                    Err(e) => return Err(format!("could not move the folder: {e}")),
                }
            }
            dest
        }
        other => return Err(format!("Unknown import mode: {other}")),
    };

    finish_import(req, id, target, None)
}

/// Drop every field of an *adopted* `project.json` that Tabtivity later reads back as
/// executable intent, keeping only the descriptive ones.
///
/// Importing a folder (or cloning/forking a repo) adopts whatever `project.json`
/// the tree happens to ship. That file is written by whoever wrote the tree, and
/// several of its fields are commands Tabtivity runs on the **host**, unprompted:
///
/// - `open_apps` — auto-launched on every project activation
///   (`services::restore_service`, which now also allowlists each entry);
/// - `tab_layout` / `tab_groups` — restored tabs whose `cmd`/`args`/`env`/`cwd`/
///   `location` become a `pty_spawn` (`services::terminal_service` sanitizes what
///   survives, but a foreign layout has no business being adopted at all);
/// - `sandbox` — the container spec, including a repo-supplied `dockerfile` that
///   `docker build`s as root, and `network`;
/// - `default_apps` — the per-extension handler `open_file` resolves;
/// - `python_interpreter` — the binary the viewer's Run/Debug executes.
///
/// The user re-establishes any of these in two clicks, so dropping them is the
/// safe direction. Pure, so the policy is unit-tested.
fn strip_untrusted_project_fields(project: &mut Project) {
    project.open_apps = None;
    project.tab_layout = None;
    project.tab_groups = None;
    project.open_tab_sessions = None;
    project.sandbox = None;
    project.default_apps = None;
    project.python_interpreter = None;
}

/// Shared tail of `import_project`: scaffold over `target`, build/merge the
/// `project.json`, register the entry in `projects.json`, and return it.
/// `remote` is `Some` for remote imports (where `target` is the mountpoint).
fn finish_import(
    req: ImportProjectRequest,
    id: String,
    target: PathBuf,
    remote: Option<RemoteSpec>,
) -> Result<ProjectEntry, String> {
    let _scaffold_fill_modes = req.scaffold_fill_modes.unwrap_or_default();

    let directory = target.to_string_lossy().to_string();
    let project_file = target.join("project.json");
    let project_file_s = project_file.to_string_lossy().to_string();

    let list = read_projects_list()?;
    // The second half of the gate: `import_project` checked the *source* before
    // touching the disk, this checks where the import actually landed (which for
    // copy/move is a different directory). Both go through the one resolver, so a
    // trailing slash or a symlink cannot slip a duplicate past either of them.
    let site = match remote.as_ref() {
        Some(spec) => ProjectSite::Remote { spec },
        None => ProjectSite::Local { dir: &directory },
    };
    if let Some(conflict) = find_project_conflict(&list, &site, None) {
        return Err(conflict_message(&conflict));
    }

    let mut git_type = normalize_git_type(req.git_type.as_deref().unwrap_or("local"));

    // Scaffold only LOCAL imports onto their (local) tree. A remote import's
    // `target` is the local per-project state dir (project.json only); its tree
    // already exists on the host, so no local scaffold is written there.
    if remote.is_none() {
        if req.skip_scaffold {
            init_repo_without_scaffold(&target, &git_type);
        } else {
            scaffold_project(&target, git_type != "none").map_err(|e| e.to_string())?;
        }
        // Same honesty rule as the remote branch below: `scaffold_project`'s
        // `git init` is best-effort, so a failed one must downgrade the label
        // rather than leave the project tagged git (or remote-private) with no
        // repo on disk. `.exists()` covers a linked worktree's `.git` *file*.
        if git_type != "none" && !target.join(".git").exists() {
            eprintln!(
                "finish_import: git init in '{}' failed; recording git_type=none so the \
                 project is not labeled git (or remote-private) without a repo",
                target.display()
            );
            git_type = "none".to_string();
        }
    }

    // A remote import keeps the host tree as the git authority (it pre-exists on
    // the host, so we never scaffold or `git init` the local mirror — pairing
    // pulls the host's history down). But when the user imports **with git
    // support** onto a host dir that is not yet a repo, there is no history for
    // lockstep to pair from; initialize a repo on the host so the mirror can be
    // paired from it. Idempotent (a dir that is already a repo is left as-is).
    //
    // The git label must reflect reality: a remote project's repo lives on the
    // host, so if we cannot establish one there, the project must NOT be tagged
    // git (else the pill shows a git badge for a project with no repo anywhere —
    // the mirror deliberately carries no `.git`). Import always runs with a live
    // connection (the user just browsed the host to pick the dir), so a failure
    // here means git genuinely could not be set up, not a transient offline —
    // downgrade to `none` so the label is honest.
    if let Some(remote) = &remote {
        if git_type != "none" {
            if let Err(e) = crate::services::ssh_exec::remote_git_init(remote) {
                eprintln!(
                    "finish_import: remote git init '{}' failed; recording git_type=none so the \
                     project is not labeled git without a repo on the host: {e}",
                    remote.remote_path
                );
                git_type = "none".to_string();
            }
        }
    }

    let now = chrono_now();
    let requested_description = clean_description(req.description);
    // As in `create_project`: read after the honesty downgrades above, so the
    // provider only rides along with a `remote-*` label that survived them.
    let git_provider = normalize_git_provider(req.git_provider.as_deref(), &git_type);

    // Remote imports mirror into `<name>` under the chosen "Local location"
    // (`mirror_parent`), defaulting to the `tabtivity/projects-ssh/` root; created up
    // front so a local-on-remote tab can cwd into it immediately. None for local.
    let mirror = remote
        .as_ref()
        .map(|_| resolve_remote_mirror(req.mirror_parent.as_deref(), &req.name, &id, &list));
    if let Some(mirror) = &mirror {
        let _ = std::fs::create_dir_all(mirror);
    }

    let project = if project_file.exists() {
        let mut existing: Project = storage::read_json(&project_file).unwrap_or_default();
        // The adopted `project.json` came with the folder — a foreign repository, a
        // clone, a fork, or a tree someone else wrote — so anything in it that
        // Tabtivity would later read back as *executable intent* must not be adopted
        // along with the descriptive fields (see `strip_untrusted_project_fields`).
        strip_untrusted_project_fields(&mut existing);
        existing.id = id.clone();
        existing.name = req.name.clone();
        existing.directory = directory.clone();
        if requested_description.is_some() {
            existing.description = requested_description.clone();
        }
        existing.git_type = Some(git_type.clone());
        existing.git_provider = git_provider.clone();
        existing.remote = remote.clone();
        existing.mirror = mirror.clone();
        existing
    } else {
        Project {
            id: id.clone(),
            name: req.name.clone(),
            directory: directory.clone(),
            description: requested_description.clone(),
            git_type: Some(git_type.clone()),
            git_provider: git_provider.clone(),
            created_at: Some(now),
            remote: remote.clone(),
            mirror: mirror.clone(),
            ..Default::default()
        }
    };
    storage::write_json(&project_file, &project).map_err(|e| e.to_string())?;

    let description = project.description.clone();
    let extra = project_extra(
        directory.clone(),
        git_type,
        git_provider,
        description,
        remote.as_ref(),
        mirror.as_deref(),
    );
    patch_projects_list(|list| {
        let site = match remote.as_ref() {
            Some(spec) => ProjectSite::Remote { spec },
            None => ProjectSite::Local { dir: &directory },
        };
        if let Some(conflict) = find_project_conflict(list, &site, None) {
            return Err(conflict_message(&conflict));
        }
        let entry = ProjectEntry {
            id,
            name: req.name,
            status: "inactive".to_string(),
            position: next_position(list),
            local_file: project_file_s,
            extra,
        };
        list.push(entry.clone());
        Ok(entry)
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtendProjectRemoteRequest {
    pub project_id: String,
    /// The remote spec to attach. `remote_path` already includes the project
    /// name leaf (the frontend appends it, matching direct remote creation).
    pub remote: RemoteSpec,
}

/// Extend an existing **local** project to remote: attach a `RemoteSpec`, create
/// the empty remote root on the host (best-effort, exactly like `create_project`),
/// and re-point the project into the mount-free remote layout **without uploading
/// any data**. The project keeps its id; its current local directory becomes the
/// local `mirror` (working copy) in place — files never move — and its `directory`
/// becomes a local state dir holding `project.json`. The user pushes files to the
/// (empty) host later via the existing manual sync UI.
#[tauri::command]
pub async fn extend_project_to_remote(
    req: ExtendProjectRemoteRequest,
    manifest: State<'_, SyncManifestState>,
) -> Result<ProjectEntry, String> {
    let list = read_projects_list()?;

    let idx = list
        .iter()
        .position(|p| p.id == req.project_id)
        .ok_or_else(|| "Project not found".to_string())?;

    // Guard: only local projects can be extended.
    if list[idx].extra.contains_key("remote") {
        return Err("Project is already remote".to_string());
    }

    // …and not onto a host folder another project already owns. Extend reaches the
    // same end state as a remote import, so it needs the same gate: two projects
    // paired to one host path means two mirrors and two lockstep states driving one
    // tree, each blind to the other. `skip_id` is this project — it is in the list
    // already, and re-pointing it is what the command is for.
    if let Some(conflict) = find_project_conflict(
        &list,
        &ProjectSite::Remote { spec: &req.remote },
        Some(&req.project_id),
    ) {
        return Err(conflict_message(&conflict));
    }

    // The current local tree becomes the mirror (working copy), unchanged.
    let old_dir = list[idx]
        .extra
        .get("directory")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "Project has no local directory".to_string())?;

    // Whether this project carries git — only then is lockstep meaningful. `none`
    // (or a missing tag) means no repo to keep in step, so we leave lockstep off.
    let git_backed = list[idx]
        .extra
        .get("git_type")
        .and_then(Value::as_str)
        .map(|t| t != "none")
        .unwrap_or(false);
    let old_path = PathBuf::from(&old_dir);
    if !old_path.is_dir() {
        return Err(format!("Local directory '{old_dir}' does not exist"));
    }

    // Best-effort create the empty remote root — same as create_project. Failure
    // is non-fatal (key/agent-auth hosts may need it to pre-exist; a password-auth
    // host connects and creates it at activation).
    if let Err(e) = crate::services::ssh_exec::remote_mkdir_p(&req.remote) {
        eprintln!(
            "extend_project_to_remote: remote mkdir '{}' failed (create it on the host if needed): {e}",
            req.remote.remote_path
        );
    }

    // The remote project's `directory` is a local state dir holding project.json.
    let state_dir = remote_project_state_dir(&req.project_id);
    std::fs::create_dir_all(&state_dir).map_err(|e| e.to_string())?;
    let new_directory = state_dir.to_string_lossy().to_string();

    // This project may have been remote before (detached, and now pointed at a different
    // host — the ordinary way to correct a wrong path). The state dir is keyed by id, so
    // any host-bound state from that earlier life is sitting right here. Clear it before
    // we write the new pairing: a manifest describing the OLD host makes byte-sync refuse
    // to push to the new one while the file tree reports green. Detach clears it too; this
    // is the belt-and-braces that also rescues a project detached by an older build, which
    // could not clear it (`remove_dir` cannot empty a non-empty directory).
    clear_host_bound_state(&req.project_id, manifest.inner()).await;

    // Move project.json from the old (now mirror) tree into the state dir, tagging
    // it remote. Read the existing one so tabs/time/created_at/etc. survive.
    let old_project_file = old_path.join("project.json");
    let mut project: Project = if old_project_file.exists() {
        storage::read_json(&old_project_file).unwrap_or_default()
    } else {
        Project::default()
    };
    project.id = req.project_id.clone();
    project.name = list[idx].name.clone();
    project.directory = new_directory.clone();
    project.remote = Some(req.remote.clone());
    project.mirror = Some(old_dir.clone());
    let new_project_file = state_dir.join("project.json");
    storage::write_json(&new_project_file, &project).map_err(|e| e.to_string())?;

    // Update the same projects.json entry in place, preserving every other extra
    // key (categories, git_provider, git_type, description, sandbox, …).
    // Persist the `mirror` pointer to projects.json BEFORE removing the old
    // project.json. If this crashes mid-way, the worst case is a harmless leftover
    // project.json in the mirror — never a lost `mirror` pointer (which would make
    // `mirror_dir` fall back to an empty state dir and desync the lockstep view).
    let updated = patch_projects_list(|list| {
        if let Some(conflict) = find_project_conflict(
            list,
            &ProjectSite::Remote { spec: &req.remote },
            Some(&req.project_id),
        ) {
            return Err(conflict_message(&conflict));
        }
        let entry = list
            .iter_mut()
            .find(|entry| entry.id == req.project_id)
            .ok_or_else(|| "Project not found".to_string())?;
        if entry.extra.contains_key("remote") {
            return Err("Project is already remote".to_string());
        }
        entry.local_file = new_project_file.to_string_lossy().to_string();
        entry.extra.insert(
            "directory".to_string(),
            Value::String(new_directory.clone()),
        );
        let value = serde_json::to_value(&req.remote).map_err(|e| e.to_string())?;
        entry.extra.insert("remote".to_string(), value);
        entry
            .extra
            .insert("mirror".to_string(), Value::String(old_dir.clone()));
        Ok(entry.clone())
    })?;

    // Extend is an explicit "keep these two in step" action, and at this instant the
    // remote root was just created empty — so the first lockstep sync can only be a
    // one-directional seed (never a divergence). Enable lockstep by default for a
    // git-backed project so the pairing stays live without the user hunting for the
    // toggle; a non-git project has nothing to sync, so it stays off. Best-effort:
    // a write failure just leaves lockstep off (its default), never blocks extend.
    if git_backed {
        // A project scaffolded before initial-commit support (`git init` only) has
        // an unborn HEAD: nothing is committed, so lockstep's `init_pairing` would
        // find no tree to check out and leave the remote empty. Seed a commit of the
        // current mirror tree now (identity-safe, gitignore-honouring) so pairing has
        // committed state to transfer. Repos that already have history are untouched.
        if git_head_unborn(&old_path) {
            git_scaffold_commit(&old_path);
        }
        let state = crate::services::git_peer::GitPeerState {
            enabled: true,
            ..Default::default()
        };
        if let Err(e) = crate::services::git_peer::save_state(&req.project_id, &state) {
            eprintln!(
                "extend_project_to_remote: could not enable lockstep for '{}' \
                 (leaving it off; user can toggle it on): {e}",
                req.project_id
            );
        }
    }

    // Now that the remote wiring is durably recorded, drop the stale project.json
    // from the working copy so the mirror is clean. Best-effort (a leftover is
    // harmless — the state-dir copy is the source of truth).
    let _ = std::fs::remove_file(&old_project_file);
    Ok(updated)
}

/// Detach a **remote** (SSH) project back to a plain local project — the inverse
/// of `extend_project_to_remote`. The project's local mirror (working copy)
/// becomes its `directory` in place; `project.json` moves from the state dir back
/// into that tree; the `remote`/`mirror` extras are dropped. **The remote host's
/// files are never touched** — only the local pointers change. The project keeps
/// its id, tabs, time, categories, git metadata, etc.
///
/// Errors if the project isn't remote, or has no local mirror to fall back to.
#[tauri::command]
pub async fn detach_project_from_remote(
    project_id: String,
    manifest: State<'_, SyncManifestState>,
) -> Result<ProjectEntry, String> {
    let list = read_projects_list()?;

    let idx = list
        .iter()
        .position(|p| p.id == project_id)
        .ok_or_else(|| "Project not found".to_string())?;

    // Guard: only remote projects can be detached.
    if !list[idx].extra.contains_key("remote") {
        return Err("Project is not remote".to_string());
    }

    // The local mirror (working copy) becomes the project directory again.
    let mirror = list[idx]
        .extra
        .get("mirror")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "Remote project has no local mirror to detach to".to_string())?;
    let mirror_path = PathBuf::from(&mirror);
    if !mirror_path.is_dir() {
        return Err(format!("Local mirror '{mirror}' does not exist"));
    }

    // Move project.json from the state dir back into the (now local) tree,
    // dropping the remote/mirror fields. Read the existing one so tabs/time/
    // created_at/etc. survive.
    let state_local_file = list[idx].local_file.clone();
    let mut project: Project = if PathBuf::from(&state_local_file).exists() {
        storage::read_json(&PathBuf::from(&state_local_file)).unwrap_or_default()
    } else {
        Project::default()
    };
    project.id = project_id.clone();
    project.name = list[idx].name.clone();
    project.directory = mirror.clone();
    project.remote = None;
    project.mirror = None;

    let new_project_file = mirror_path.join("project.json");
    storage::write_json(&new_project_file, &project).map_err(|e| e.to_string())?;

    // Re-point the saved tabs at the mirror. While the project was remote its
    // `directory` WAS the state dir, so that is what every tab holds as its cwd —
    // harmless then (the frontend rewrote it at render time, gated on the project
    // being remote), a dangling path the moment it isn't. Left alone, a restored
    // agent relaunches inside the state dir this detach is about to delete, and
    // Claude — which keys its session history by cwd — finds no conversation to
    // `--resume`. The frontend fixes the LIVE tabs (`detachScopeFromRemote`); this
    // fixes the ones on disk, which is what a restart restores from.
    //
    // The layout is keyed by **project id**, which a detach does not change, so
    // there is nothing to move or copy any more — and no stale mirror-side session
    // file to lose the tabs to. (That is what the old code was working around: the
    // layout used to be keyed by `local_file`, so a detach swapped which file was
    // authoritative and the mirror's leftover copy silently won.)
    let state_dir = remote_project_state_dir(&project_id);
    let state_dir_s = state_dir.to_string_lossy().to_string();
    let new_local_file = new_project_file.to_string_lossy().to_string();
    // project-tree-read: ok — the state-dir `TerminalSession`, edited in place
    // by project id through the workspace service (which moves the scope's
    // version, so a client holding the old cwds re-syncs against these); the
    // whole block never touches the project tree.
    if !crate::services::terminal_service::load_terminal_session(&project_id).tab_layout.is_empty() {
        let _ = crate::services::workspace::edit(&project_id, &new_local_file, |session| {
            for tab in session.tab_layout.iter_mut() {
                if tab.cwd == state_dir_s {
                    tab.cwd = mirror.clone();
                } else if let Some(rest) = tab.cwd.strip_prefix(&format!("{state_dir_s}/")) {
                    tab.cwd = format!("{mirror}/{rest}");
                }
            }
            Ok(())
        });
    }

    // Drop everything that was bound to the host we are detaching from. Not merely
    // hygiene: the project keeps its id, so a later "extend to remote" — the whole point
    // of detaching, when the old path was wrong — lands on this same state dir and would
    // otherwise inherit a byte-sync manifest whose bases describe the OLD host. See
    // `clear_host_bound_state` for what that silently does to the new one.
    clear_host_bound_state(&project_id, manifest.inner()).await;

    // Remove the old state-dir project.json, its session mirror, and then the state dir.
    // `.tabtivity/` is why the dir used to survive every detach: `remove_dir` is
    // non-recursive, so it failed on a dir that still held the session mirror, and the
    // project's id was left lying around under `remote-projects/` forever.
    //
    // The final `remove_dir` stays non-recursive ON PURPOSE — `local_loss.json`
    // deliberately outlives a detach (it records what was destroyed in the *local*
    // mirror, and the user may not have seen it yet). A dir that still holds it must
    // survive; `remove_dir` succeeds only once the dir is genuinely empty, which is
    // exactly that distinction.
    let _ = std::fs::remove_file(&state_local_file);
    let _ = std::fs::remove_dir_all(state_dir.join(crate::brand::PROJECT_DIR));
    let _ = std::fs::remove_dir(&state_dir);

    // Update the projects.json entry in place, preserving every other extra key
    // (categories, git_provider, git_type, description, sandbox, …).
    let updated = patch_project_entry(&project_id, |entry| {
        if !entry.extra.contains_key("remote") {
            return Err("Project is not remote".to_string());
        }
        entry.local_file = new_project_file.to_string_lossy().to_string();
        entry
            .extra
            .insert("directory".to_string(), Value::String(mirror));
        entry.extra.remove("remote");
        entry.extra.remove("mirror");
        Ok(entry.clone())
    })?;
    Ok(updated)
}

// ── Time tracking ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_time_today(project_id: String) -> Result<f64, String> {
    // Efficiency #2: O(1) lookup in the rolling daily-summary file instead of
    // fully deserializing the growing append-only log on every pill hover.
    crate::schema::time_log::today_secs(&project_id)
}

// ── Helpers ───────────────────────────────────────────────────────────────

pub(crate) fn next_position(list: &ProjectsList) -> i64 {
    list.iter().map(|p| p.position).max().unwrap_or(0) + 10
}

fn project_extra(
    directory: String,
    git_type: String,
    git_provider: Option<String>,
    description: Option<String>,
    remote: Option<&RemoteSpec>,
    mirror: Option<&str>,
) -> HashMap<String, Value> {
    let mut extra = HashMap::from([
        ("directory".to_string(), Value::String(directory)),
        ("git_type".to_string(), Value::String(git_type)),
    ]);
    // The hosting badge's own axis (`publish_project` writes the same key) — the
    // pill reads it without sniffing `origin`.
    if let Some(provider) = git_provider {
        extra.insert("git_provider".to_string(), Value::String(provider));
    }
    if let Some(description) = description {
        extra.insert("description".to_string(), Value::String(description));
    }
    // Mirror the remote spec into the pill-list entry (like `directory`/
    // `git_type`) so the frontend can flag remote projects without reading
    // each project.json. Serialization should never fail for a plain struct.
    if let Some(remote) = remote {
        if let Ok(value) = serde_json::to_value(remote) {
            extra.insert("remote".to_string(), value);
        }
    }
    // The chosen local mirror root (remote projects only) — the always-local
    // source of truth `remote_sync::mirror_dir` reads.
    if let Some(mirror) = mirror {
        extra.insert("mirror".to_string(), Value::String(mirror.to_string()));
    }
    extra
}

fn clean_description(description: Option<String>) -> Option<String> {
    description.and_then(|description| {
        let description = description.trim().to_string();
        if description.is_empty() {
            None
        } else {
            Some(description)
        }
    })
}

pub(crate) fn projects_root() -> PathBuf {
    paths::projects_root()
}

pub(crate) fn sanitize_name(name: &str) -> String {
    name.trim()
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

/// Copy a tree, leaving git's administrative state behind.
///
/// `.git` is skipped whatever **kind** of entry it is (#23 D3). Testing `is_dir()`
/// first — as this did — let a linked worktree's `.git` *file* through, and that file
/// is one line: `gitdir: <main>/.git/worktrees/<name>`. Copying it produces a second
/// directory claiming the **same** admin entry, so git operations in the copy write
/// into the original's index and HEAD. A directory holding one is likewise not copied
/// into: a nested repo or worktree is not this tree's content to duplicate.
fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    copy_tree_core(src, dst, false)
}

/// Mint a random RFC 4122 v4 UUID (36 chars, `8-4-4-4-12`). It must be a real
/// UUID: it is passed as `claude --session-id` and checked by
/// `agent_session::is_uuid_shaped`. Ids minted by older builds repeat a
/// nanosecond timestamp in every group (85 chars); they stay valid as ids.
/// Should the system RNG fail, the bytes fall back to the clock, so callers
/// that mint several ids back-to-back keep their collision guards (see
/// `commands::boxes::create_box`).
pub(crate) fn uuid_v4() -> String {
    let mut b = [0u8; 16];
    if getrandom::fill(&mut b).is_err() {
        use std::time::{SystemTime, UNIX_EPOCH};
        let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
        b = ts.to_le_bytes();
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

fn chrono_now() -> String {
    storage::iso_now()
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    /// The Mobile keys follow the switch: a list is written only with access
    /// on, "every phone" removes it, off removes both — and every other key
    /// of the entry, Python-era ones included, rides through untouched.
    #[test]
    fn mobile_access_writes_and_removes_both_keys_and_keeps_the_rest() {
        let access = crate::brand::MOBILE_ACCESS_KEY;
        let devices = crate::brand::MOBILE_DEVICES_KEY;
        let raw = serde_json::json!({
            "id": "p", "name": "P", "status": "active", "position": 3, "local_file": "/p/project.json",
            "directory": "/p", "python_era_field": { "kept": [1, 2] },
        });
        let mut entry: super::ProjectEntry = serde_json::from_value(raw.clone()).unwrap();
        let ids = vec!["a".repeat(27)];

        super::apply_mobile_access(&mut entry, true, Some(&ids));
        let on = serde_json::to_value(&entry).unwrap();
        assert_eq!(on[access], true);
        assert_eq!(on[devices], serde_json::json!(ids));
        assert_eq!(on["python_era_field"], raw["python_era_field"]);

        super::apply_mobile_access(&mut entry, true, None);
        let all = serde_json::to_value(&entry).unwrap();
        assert_eq!(all[access], true);
        assert!(all.get(devices).is_none(), "every phone is the key's absence");

        super::apply_mobile_access(&mut entry, true, Some(&ids));
        super::apply_mobile_access(&mut entry, false, None);
        assert_eq!(serde_json::to_value(&entry).unwrap(), raw, "off leaves the entry as it was");
    }

    /// An omitted list is every phone, and asks nothing of `devices.json`
    /// (the asked-list checks are `auth::scope_device_list`'s tests).
    #[test]
    fn an_omitted_device_list_is_every_phone() {
        assert_eq!(super::mobile_scope_devices(None), Ok(None));
    }

    use super::*;

    /// A minted id is a real v4 UUID: `claude --session-id` rejects anything else.
    #[test]
    fn uuid_v4_is_a_real_v4_uuid() {
        let a = uuid_v4();
        assert_eq!(a.len(), 36);
        assert!(crate::services::agent_session::is_uuid_shaped(&a), "{a}");
        assert_eq!(&a[14..15], "4");
        assert!(matches!(&a[19..20], "8" | "9" | "a" | "b"), "{a}");
        assert_ne!(a, uuid_v4());
    }

    /// git writes a worktree's `gitdir` with `/` on every OS; the folder paths
    /// come from `projects.json` in the OS's own form (`\` on Windows). The
    /// worktree under the renamed folder is still found.
    #[test]
    fn moved_linked_worktrees_matches_gits_slashes() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("before");
        let new = tmp.path().join("after");
        let (old_s, new_s) = (old.to_string_lossy().to_string(), new.to_string_lossy().to_string());
        let meta = new.join(".git").join("worktrees").join("feature");
        std::fs::create_dir_all(&meta).unwrap();
        let gitdir = format!("{}/wt/feature/.git\n", old_s.replace('\\', "/"));
        std::fs::write(meta.join("gitdir"), gitdir).unwrap();

        let moved = moved_linked_worktrees(&new, &old_s, &new_s);
        assert_eq!(moved.len(), 1, "{moved:?}");
        assert_eq!(moved[0], new.join("wt").join("feature"));
    }

    /// A folder rename re-points the linked worktree that moved inside it, so
    /// it still works from both ends.
    #[test]
    fn a_renamed_folder_repairs_the_worktree_inside_it() {
        fn git(dir: &Path, args: &[&str]) -> String {
            let out = crate::commands::git::hardened_git_command_in(dir, args)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@example.invalid")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@example.invalid")
                .output()
                .expect("git runs");
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        }
        let tmp = tempfile::tempdir().unwrap();
        // Resolved (macOS' /var symlink), without Windows' `\\?\` prefix.
        let root = PathBuf::from(crate::commands::fs::display_path(&tmp.path().canonicalize().unwrap()));
        let old = root.join("before");
        std::fs::create_dir_all(&old).unwrap();
        git(&old, &["init", "-q", "-b", "main"]);
        std::fs::write(old.join("a.txt"), b"a\n").unwrap();
        git(&old, &["add", "a.txt"]);
        git(&old, &["commit", "-q", "-m", "first"]);
        let inside = Path::new("wt").join("feature");
        git(&old, &["worktree", "add", "-q", "-b", "feature", &old.join(&inside).to_string_lossy()]);

        let new = root.join("after");
        std::fs::rename(&old, &new).unwrap();
        repair_moved_worktrees(&new, &old.to_string_lossy(), &new.to_string_lossy()).unwrap();

        let worktree = new.join(&inside);
        assert_eq!(git(&worktree, &["rev-parse", "--abbrev-ref", "HEAD"]), "feature");
        assert_eq!(git(&worktree, &["status", "--porcelain"]), "");
        let listed = git(&new, &["worktree", "list", "--porcelain"]);
        assert!(!listed.contains("prunable"), "{listed}");
    }

    /// `forget_project` purges only Tabtivity's state dirs about a project: a dir
    /// that is there goes, one that never existed is not an error, and a
    /// sibling that is not on the list — the project folder — is untouched.
    #[test]
    fn remove_dirs_if_present_skips_missing_and_leaves_siblings_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let sessions = tmp.path().join("sessions").join("p1");
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::write(sessions.join("layout.json"), b"{}").unwrap();
        let project = tmp.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("README.md"), b"mine").unwrap();
        std::fs::write(project.join("project.json"), b"{}").unwrap();
        let never_created = tmp.path().join("live_sessions").join("p1");

        remove_dirs_if_present(&[sessions.clone(), never_created.clone()]).unwrap();

        assert!(!sessions.exists(), "the session dir is gone");
        assert!(!never_created.exists());
        assert_eq!(std::fs::read(project.join("README.md")).unwrap(), b"mine");
        assert!(project.join("project.json").exists());
    }

    /// A VM project's overlay disk is its tree, so "keep the folder" has no
    /// meaning for it — `forget_project` dispatches on this and refuses.
    #[test]
    fn entry_is_vm_reads_the_vm_spec() {
        let mut entry = ProjectEntry {
            id: "p1".into(),
            name: "P".into(),
            status: "inactive".into(),
            position: 0,
            local_file: "/tmp/p1/project.json".into(),
            extra: HashMap::new(),
        };
        assert!(!entry_is_vm(&entry));
        entry
            .extra
            .insert("vm".to_string(), Value::Null);
        assert!(!entry_is_vm(&entry), "an explicit null is not a VM");
        entry
            .extra
            .insert("vm".to_string(), serde_json::json!({ "image": "x" }));
        assert!(entry_is_vm(&entry));
    }

    /// An interrupted archive leaves a partial destination, and a retry must
    /// resume *into* it. `rename` onto a non-empty directory fails with
    /// `ENOTEMPTY`, not a cross-device error, so `move_tree` keeps copying when
    /// the destination already exists.
    #[test]
    fn move_tree_resumes_into_a_partial_destination() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        std::fs::create_dir_all(src.join("sub")).unwrap();
        std::fs::write(src.join("a.txt"), b"new-a").unwrap();
        std::fs::write(src.join("sub/b.txt"), b"new-b").unwrap();

        let dst = tmp.path().join("archive").join("dir");
        std::fs::create_dir_all(&dst).unwrap();
        std::fs::write(dst.join("a.txt"), b"partial").unwrap();

        move_tree(&src, &dst).unwrap();

        assert!(!src.exists(), "the source is removed once the copy completed");
        assert_eq!(std::fs::read(dst.join("a.txt")).unwrap(), b"new-a");
        assert_eq!(std::fs::read(dst.join("sub/b.txt")).unwrap(), b"new-b");
    }

    /// A rename refused for any reason other than a cross-device move, with no
    /// destination in the way, is reported — never answered with a full copy
    /// that then cannot remove its source.
    #[cfg(unix)]
    #[test]
    fn move_tree_surfaces_a_non_cross_device_rename_error() {
        use std::os::unix::fs::PermissionsExt;
        if unsafe { libc::geteuid() } == 0 {
            // Root ignores the directory permission this test relies on.
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let locked = tmp.path().join("locked");
        let src = locked.join("src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("a.txt"), b"x").unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();

        let dst = tmp.path().join("dst");
        let result = move_tree(&src, &dst);
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();

        assert!(result.is_err(), "EACCES must surface: {result:?}");
        assert!(!dst.exists(), "no copy was made");
        assert!(src.join("a.txt").exists(), "the source is untouched");
    }

    /// #23 D3. `copy_dir_all` skipped `.git` only when `is_dir()`, so in a linked
    /// worktree the one-line `.git` FILE (`gitdir: <main>/.git/worktrees/<name>`)
    /// was copied — producing a second directory claiming the SAME admin entry, in
    /// which git writes into the original's index and HEAD.
    #[test]
    fn copying_a_tree_never_carries_a_git_pointer_of_either_kind() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        std::fs::create_dir_all(src.join(".git")).unwrap();
        std::fs::write(src.join(".git/HEAD"), b"ref: refs/heads/main").unwrap();
        std::fs::write(src.join("a.txt"), b"x").unwrap();

        // A linked worktree inside the tree: `.git` is a file, not a directory.
        let wt = src.join("wt");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(wt.join(".git"), b"gitdir: /elsewhere/.git/worktrees/wt").unwrap();
        std::fs::write(wt.join("b.txt"), b"x").unwrap();

        let dst = tmp.path().join("dst");
        copy_dir_all(&src, &dst).unwrap();

        assert!(dst.join("a.txt").exists());
        assert!(
            !dst.join(".git").exists(),
            "the repo's own .git must not travel"
        );
        assert!(
            !dst.join("wt").exists(),
            "a directory holding a .git of either kind is not this tree's content"
        );
    }

    /// §9.4: the archive/move copy (`keep_git: true`) carries `.git` verbatim —
    /// the tree IS the project, history included — where the duplicate path
    /// (`copy_dir_all`) leaves it behind.
    #[test]
    fn the_move_copy_carries_git_state_verbatim() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        std::fs::create_dir_all(src.join(".git")).unwrap();
        std::fs::write(src.join(".git/HEAD"), b"ref: refs/heads/main").unwrap();
        std::fs::write(src.join("a.txt"), b"x").unwrap();

        let dst = tmp.path().join("dst");
        copy_tree_core(&src, &dst, true).unwrap();
        assert!(dst.join("a.txt").exists());
        assert!(dst.join(".git/HEAD").exists());
    }

    /// §9.4: symlinks are recreated as links (never followed), and a DANGLING
    /// one — a stale venv/node `bin` pointer is the ordinary case — is copied
    /// rather than erroring out the whole move partway, which used to strand a
    /// cross-device `archive_project` in an unretryable half-moved state.
    #[cfg(unix)]
    #[test]
    fn symlinks_are_preserved_and_a_dangling_one_is_tolerated() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("real.txt"), b"x").unwrap();
        std::os::unix::fs::symlink("real.txt", src.join("live-link")).unwrap();
        std::os::unix::fs::symlink("/nonexistent/python", src.join("dangling")).unwrap();

        let dst = tmp.path().join("dst");
        copy_tree_core(&src, &dst, true).unwrap();

        assert_eq!(
            std::fs::read_link(dst.join("live-link")).unwrap(),
            std::path::PathBuf::from("real.txt"),
            "a live link must stay a link, not become a second copy"
        );
        assert_eq!(
            std::fs::read_link(dst.join("dangling")).unwrap(),
            std::path::PathBuf::from("/nonexistent/python"),
            "a dangling link is carried, not an error"
        );
        // Re-run over the same destination: a resumed archive pass must be
        // idempotent, including replacing the links it already made.
        copy_tree_core(&src, &dst, true).unwrap();
    }

    /// A worktree copied as a bare directory would be worse than useless — but a
    /// stray `.git` FILE at the top level must be dropped too, whatever the tree
    /// around it looks like.
    #[test]
    fn a_worktree_rooted_source_copies_its_files_without_its_git_file() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("wt");
        std::fs::create_dir_all(src.join("sub")).unwrap();
        std::fs::write(src.join(".git"), b"gitdir: /elsewhere/.git/worktrees/wt").unwrap();
        std::fs::write(src.join("sub/a.txt"), b"x").unwrap();

        let dst = tmp.path().join("dst");
        copy_dir_all(&src, &dst).unwrap();
        assert!(dst.join("sub/a.txt").exists());
        assert!(!dst.join(".git").exists());
    }

    // ── Duplicate registration ─────────────────────────────────────────────

    fn entry(id: &str, name: &str, extra: Vec<(&str, Value)>) -> ProjectEntry {
        ProjectEntry {
            id: id.to_string(),
            name: name.to_string(),
            status: "inactive".to_string(),
            position: 10,
            local_file: format!("/p/{id}/project.json"),
            extra: extra.into_iter().map(|(k, v)| (k.to_string(), v)).collect(),
        }
    }

    /// A project keeps an old-named screenshots or mail folder it already
    /// has, so the default ignore list names both spellings: regenerating a
    /// `.gitignore` must never un-ignore a folder of filed private data.
    #[test]
    fn the_default_gitignore_covers_the_generated_folders_under_both_names() {
        let lines: Vec<&str> = GITIGNORE_DEFAULT.lines().collect();
        for dir in [
            crate::brand::SCREENSHOTS_DIR,
            crate::brand::EMAILS_DIR,
            crate::brand::LEGACY_SCREENSHOTS_DIR,
            crate::brand::LEGACY_EMAILS_DIR,
        ] {
            assert!(lines.contains(&format!("{dir}/").as_str()), "{dir}/ is ignored");
        }
        assert!(lines.contains(&crate::brand::PROJECT_DIR_EXCLUDE_RULE));
        assert!(lines.contains(&"screenshots/") && lines.contains(&"emails/"));
    }

    #[test]
    fn the_retired_trash_workspace_entry_is_dropped_and_nothing_else() {
        let mut list = vec![
            // The entry an old build wrote: its id and its marker carry the old name.
            entry(paths::LEGACY_TRASH_PROJECT_ID, "Trash", vec![(concat!(crate::legacy_slug!(), "_trash"), Value::Bool(true))]),
            entry("p1", "Trash", vec![]),
        ];
        drop_legacy_trash_project(&mut list);
        let ids: Vec<&str> = list.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, ["p1"]);
    }

    fn local_entry(id: &str, name: &str, dir: &str) -> ProjectEntry {
        entry(
            id,
            name,
            vec![("directory", Value::String(dir.to_string()))],
        )
    }

    // ── Project folder rename ──────────────────────────────────────────────

    fn dir_rename_status(list: &ProjectsList, id: &str, leaf: &str) -> String {
        plan_dir_rename(list, id, false, leaf).unwrap().status
    }

    #[test]
    fn dir_rename_plan_refuses_anything_already_at_the_target() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("alpha");
        fs::create_dir(&old).unwrap();
        fs::create_dir(tmp.path().join("taken")).unwrap();
        fs::write(tmp.path().join("afile"), "x").unwrap();
        let list = vec![local_entry("a", "Alpha", &old.to_string_lossy())];

        assert_eq!(dir_rename_status(&list, "a", "beta"), "ok");
        assert_eq!(dir_rename_status(&list, "a", "  beta "), "ok");
        assert_eq!(dir_rename_status(&list, "a", "alpha"), "same");
        assert_eq!(dir_rename_status(&list, "a", "taken"), "exists");
        assert_eq!(dir_rename_status(&list, "a", "afile"), "exists");
        let plan = plan_dir_rename(&list, "a", false, "beta").unwrap();
        assert_eq!(plan.target_dir, tmp.path().join("beta").to_string_lossy());
    }

    #[test]
    fn dir_rename_plan_rejects_bad_leaves_and_unsupported_projects() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("alpha");
        fs::create_dir(&old).unwrap();
        let dir = old.to_string_lossy().to_string();
        let mut vm = local_entry("v", "Vm", &dir);
        vm.extra
            .insert("vm".into(), serde_json::json!({ "enabled": true }));
        let list = vec![
            local_entry("a", "Alpha", &dir),
            vm,
            local_entry("gone", "Gone", &tmp.path().join("nope").to_string_lossy()),
        ];
        for bad in ["", "..", "a/b", "a\\b", "x:", "trail.", "a\tb"] {
            assert_eq!(dir_rename_status(&list, "a", bad), "invalid", "{bad:?}");
        }
        assert_eq!(plan_dir_rename(&list, "a", true, "b").unwrap().status, "unsupported");
        assert_eq!(dir_rename_status(&list, "v", "b"), "unsupported");
        assert_eq!(dir_rename_status(&list, "gone", "b"), "missing");
        assert!(plan_dir_rename(&list, "nobody", false, "b").is_err());
    }

    #[test]
    fn dir_rename_plan_guards_other_projects_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("alpha");
        fs::create_dir(&old).unwrap();
        let dir = old.to_string_lossy().to_string();
        // A registered project whose folder was deleted still owns its path.
        let registered = local_entry("r", "R", &tmp.path().join("beta").to_string_lossy());
        let list = vec![local_entry("a", "Alpha", &dir), registered];
        assert_eq!(dir_rename_status(&list, "a", "beta"), "registered");

        // Another project living inside this folder would lose its path.
        let inner = local_entry("i", "Inner", &format!("{dir}/sub"));
        let list = vec![local_entry("a", "Alpha", &dir), inner];
        assert_eq!(dir_rename_status(&list, "a", "gamma"), "nested");
        // …but a sibling that merely shares the prefix does not.
        let sibling = local_entry("s", "S", &format!("{dir}x"));
        let list = vec![local_entry("a", "Alpha", &dir), sibling];
        assert_eq!(dir_rename_status(&list, "a", "gamma"), "ok");
    }

    #[test]
    fn rename_dir_no_replace_never_touches_an_existing_target() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("alpha");
        fs::create_dir(&old).unwrap();
        fs::write(old.join("keep.txt"), "mine").unwrap();
        // An EMPTY directory is exactly what plain `rename(2)` would replace.
        let empty = tmp.path().join("empty");
        fs::create_dir(&empty).unwrap();
        assert!(rename_dir_no_replace(&old, &empty).is_err());
        assert!(old.join("keep.txt").exists());
        assert!(empty.is_dir());

        let full = tmp.path().join("full");
        fs::create_dir(&full).unwrap();
        fs::write(full.join("theirs.txt"), "theirs").unwrap();
        assert!(rename_dir_no_replace(&old, &full).is_err());
        assert!(!full.join("keep.txt").exists());

        let free = tmp.path().join("beta");
        rename_dir_no_replace(&old, &free).unwrap();
        assert!(!old.exists());
        assert_eq!(fs::read_to_string(free.join("keep.txt")).unwrap(), "mine");
    }

    fn spec(user: Option<&str>, host: &str, port: Option<u16>, path: &str) -> RemoteSpec {
        RemoteSpec {
            user: user.map(str::to_string),
            host: host.to_string(),
            port,
            remote_path: path.to_string(),
            openvpn: None,
            auto_connect: None,
            key_auth: None,
            persist_sessions: None,
            vm: None,
            label: None,
            extra: HashMap::new(),
        }
    }

    fn remote_entry(id: &str, name: &str, spec: &RemoteSpec, mirror: Option<&str>) -> ProjectEntry {
        let mut extra = vec![
            (
                "directory",
                Value::String(format!("/state/remote-projects/{id}")),
            ),
            ("remote", serde_json::to_value(spec).unwrap()),
        ];
        if let Some(mirror) = mirror {
            extra.push(("mirror", Value::String(mirror.to_string())));
        }
        entry(id, name, extra)
    }

    #[test]
    fn lexical_normalize_drops_cur_dir_and_trailing_separator() {
        assert_eq!(
            lexical_normalize(Path::new("/a/./foo/")),
            PathBuf::from("/a/foo")
        );
    }

    #[test]
    fn lexical_normalize_pops_parent_dir() {
        assert_eq!(
            lexical_normalize(Path::new("/a/b/../foo")),
            PathBuf::from("/a/foo")
        );
    }

    #[test]
    fn lexical_normalize_keeps_leading_parent_dir_of_relative_path() {
        // Nothing to pop, so `..` has to survive or the path changes meaning.
        assert_eq!(lexical_normalize(Path::new("../a")), PathBuf::from("../a"));
    }

    #[test]
    fn lexical_normalize_cannot_climb_above_root() {
        assert_eq!(lexical_normalize(Path::new("/../a")), PathBuf::from("/a"));
    }

    #[test]
    fn local_dir_key_ignores_trailing_separator() {
        // The case the old string compare missed: one folder, two spellings.
        assert_eq!(
            local_dir_key("/no/such/dir/foo/"),
            local_dir_key("/no/such/dir/foo")
        );
    }

    #[test]
    fn local_dir_key_is_empty_for_blank_input() {
        assert_eq!(local_dir_key("   "), "");
    }

    #[test]
    fn remote_path_key_normalizes_separators() {
        assert_eq!(remote_path_key("/home//alice/./work/"), "/home/alice/work");
    }

    #[test]
    fn remote_path_key_keeps_root() {
        assert_eq!(remote_path_key("/"), "/");
    }

    #[test]
    fn remote_path_key_leaves_tilde_unexpanded() {
        // Only the host knows what `~` resolves to; guessing would merge or split
        // two folders on no evidence.
        assert_eq!(remote_path_key("~/work"), "~/work");
        assert_ne!(
            remote_path_key("~/work"),
            remote_path_key("/home/alice/work")
        );
    }

    #[test]
    fn ssh_target_key_defaults_port_and_lowercases_host() {
        assert_eq!(
            ssh_target_key(&spec(Some("alice"), "Build.Example.COM", None, "/w")),
            ssh_target_key(&spec(Some("alice"), "build.example.com", Some(22), "/w"))
        );
    }

    #[test]
    fn ssh_target_key_treats_blank_user_as_absent() {
        assert_eq!(
            ssh_target_key(&spec(Some("  "), "h", None, "/w")),
            ssh_target_key(&spec(None, "h", None, "/w"))
        );
    }

    #[test]
    fn conflict_finds_same_local_directory() {
        let list = vec![local_entry("a", "Foo", "/no/such/dir/foo")];
        let found = find_project_conflict(
            &list,
            &ProjectSite::Local {
                dir: "/no/such/dir/foo/",
            },
            None,
        )
        .expect("trailing separator must not hide a duplicate");
        assert_eq!(found.id, "a");
        assert_eq!(found.name, "Foo");
        assert_eq!(found.kind, "directory");
    }

    #[test]
    fn conflict_ignores_an_unrelated_directory() {
        let list = vec![local_entry("a", "Foo", "/no/such/dir/foo")];
        assert!(find_project_conflict(
            &list,
            &ProjectSite::Local {
                dir: "/no/such/dir/bar"
            },
            None
        )
        .is_none());
    }

    #[test]
    fn conflict_flags_a_remote_projects_mirror() {
        // The mirror is a real local tree lockstep already owns — importing it as
        // its own project puts two projects on one working copy.
        let list = vec![remote_entry(
            "a",
            "Foo",
            &spec(Some("alice"), "h", None, "/work"),
            Some("/no/such/dir/mirror"),
        )];
        let found = find_project_conflict(
            &list,
            &ProjectSite::Local {
                dir: "/no/such/dir/mirror",
            },
            None,
        )
        .expect("a mirror is an owned tree");
        assert_eq!(found.kind, "mirror");
    }

    #[test]
    fn conflict_finds_same_host_path() {
        // The gap the old check could not see at all: a remote project's registered
        // `directory` is a per-id state dir, so it never matched twice.
        let list = vec![remote_entry(
            "a",
            "Foo",
            &spec(Some("alice"), "build.example.com", None, "/home/alice/work"),
            None,
        )];
        let found = find_project_conflict(
            &list,
            &ProjectSite::Remote {
                spec: &spec(
                    Some("alice"),
                    "Build.Example.com",
                    Some(22),
                    "/home/alice/work/",
                ),
            },
            None,
        )
        .expect("same login, same host, same path");
        assert_eq!(found.kind, "remote-path");
        assert_eq!(found.id, "a");
    }

    #[test]
    fn conflict_treats_a_different_login_as_a_different_site() {
        let list = vec![remote_entry(
            "a",
            "Foo",
            &spec(Some("alice"), "h", None, "/work"),
            None,
        )];
        assert!(find_project_conflict(
            &list,
            &ProjectSite::Remote {
                spec: &spec(Some("bob"), "h", None, "/work")
            },
            None
        )
        .is_none());
    }

    #[test]
    fn conflict_treats_a_different_port_as_a_different_site() {
        let list = vec![remote_entry(
            "a",
            "Foo",
            &spec(Some("alice"), "h", Some(22), "/work"),
            None,
        )];
        assert!(find_project_conflict(
            &list,
            &ProjectSite::Remote {
                spec: &spec(Some("alice"), "h", Some(2222), "/work")
            },
            None
        )
        .is_none());
    }

    #[test]
    fn conflict_does_not_match_a_nested_host_path() {
        // A subfolder of a paired root is its own site; a prefix compare would
        // wrongly claim `/work2` collides with `/work`.
        let list = vec![remote_entry(
            "a",
            "Foo",
            &spec(Some("alice"), "h", None, "/work"),
            None,
        )];
        for path in ["/work2", "/work/sub"] {
            assert!(
                find_project_conflict(
                    &list,
                    &ProjectSite::Remote {
                        spec: &spec(Some("alice"), "h", None, path)
                    },
                    None
                )
                .is_none(),
                "{path} must not collide with /work"
            );
        }
    }

    #[test]
    fn conflict_skips_the_project_being_repointed() {
        // Extend-to-remote edits an entry that is already in the list.
        let list = vec![remote_entry(
            "a",
            "Foo",
            &spec(Some("alice"), "h", None, "/work"),
            None,
        )];
        let site = ProjectSite::Remote {
            spec: &spec(Some("alice"), "h", None, "/work"),
        };
        assert!(find_project_conflict(&list, &site, Some("a")).is_none());
        assert!(find_project_conflict(&list, &site, Some("other")).is_some());
    }

    #[test]
    fn conflict_message_names_the_existing_project() {
        let conflict = ProjectConflict {
            id: "a".to_string(),
            name: "Foo".to_string(),
            kind: "directory".to_string(),
        };
        assert!(conflict_message(&conflict).contains("Foo"));
    }

    // ── sanitize_name ──────────────────────────────────────────────────────

    #[test]
    fn sanitize_name_lowercase_alphanumeric() {
        assert_eq!(sanitize_name("MyProject"), "myproject");
    }

    #[test]
    fn sanitize_name_replaces_spaces_with_dash() {
        assert_eq!(sanitize_name("my project"), "my-project");
    }

    #[test]
    fn sanitize_name_replaces_special_chars() {
        assert_eq!(sanitize_name("my!project@2"), "my-project-2");
    }

    #[test]
    fn sanitize_name_collapses_consecutive_dashes() {
        assert_eq!(sanitize_name("my  project"), "my-project");
        assert_eq!(sanitize_name("a---b"), "a-b");
    }

    #[test]
    fn sanitize_name_trims_leading_trailing_dashes() {
        assert_eq!(sanitize_name("  hello  "), "hello");
        assert_eq!(sanitize_name("!hello!"), "hello");
    }

    #[test]
    fn sanitize_name_preserves_underscore() {
        assert_eq!(sanitize_name("my_project"), "my_project");
    }

    #[test]
    fn sanitize_name_empty_after_stripping() {
        assert_eq!(sanitize_name("!!!"), "");
        assert_eq!(sanitize_name(""), "");
        assert_eq!(sanitize_name("   "), "");
    }

    #[test]
    fn sanitize_name_numeric_only() {
        assert_eq!(sanitize_name("123"), "123");
    }

    #[test]
    fn sanitize_name_unicode_becomes_dash() {
        // Non-ASCII chars are replaced with '-', then collapsed.
        let result = sanitize_name("café");
        assert!(!result.contains("é"), "unicode must be replaced");
        assert!(!result.contains("--"), "consecutive dashes collapsed");
    }

    // ── normalize_git_type ─────────────────────────────────────────────────

    #[test]
    fn normalize_git_type_migrates_legacy_values() {
        assert_eq!(normalize_git_type("private"), "remote-private");
        assert_eq!(normalize_git_type("public"), "remote-public");
    }

    #[test]
    fn normalize_git_type_passes_through_canonical_values() {
        assert_eq!(normalize_git_type("local"), "local");
        assert_eq!(normalize_git_type("none"), "none");
        assert_eq!(normalize_git_type("remote-private"), "remote-private");
        assert_eq!(normalize_git_type("remote-public"), "remote-public");
    }

    #[test]
    fn normalize_git_type_unknown_falls_back_to_local() {
        assert_eq!(normalize_git_type(""), "local");
        assert_eq!(normalize_git_type("weird"), "local");
        assert_eq!(normalize_git_type("  public  "), "remote-public");
    }

    #[test]
    fn git_provider_rides_only_on_a_hosted_project() {
        // The clone/fork URL's own host, kept for the two providers Tabtivity speaks.
        assert_eq!(
            normalize_git_provider(Some("GitHub"), "remote-private").as_deref(),
            Some("github")
        );
        assert_eq!(
            normalize_git_provider(Some(" gitlab "), "remote-public").as_deref(),
            Some("gitlab")
        );
        // A project pushed nowhere must not carry a hosting badge…
        assert_eq!(normalize_git_provider(Some("github"), "local"), None);
        assert_eq!(normalize_git_provider(Some("github"), "none"), None);
        // …and neither does an unrecognized (self-hosted) host.
        assert_eq!(normalize_git_provider(Some("gitea"), "remote-private"), None);
        assert_eq!(normalize_git_provider(None, "remote-private"), None);
    }

    // ── normalize_entry ────────────────────────────────────────────────────

    fn legacy_entry() -> ProjectEntry {
        // A pre-Group-D stub like the self-hosting checkout's entry: core fields only,
        // no `directory`, no `git_type`.
        ProjectEntry {
            id: "legacy-id".to_string(),
            name: concat!("Project", crate::app_name!()).to_string(),
            status: "active".to_string(),
            position: 10,
            local_file: concat!("/home/u/", crate::app_slug!(), "/projects/project", crate::app_slug!(), "/project.json").to_string(),
            extra: HashMap::new(),
        }
    }

    #[test]
    fn normalize_entry_backfills_directory_from_local_file() {
        let mut entry = legacy_entry();
        normalize_entry(&mut entry);
        assert_eq!(
            entry.extra.get("directory").and_then(Value::as_str),
            Some(concat!("/home/u/", crate::app_slug!(), "/projects/project", crate::app_slug!())),
        );
    }

    #[test]
    fn normalize_entry_keeps_existing_directory() {
        let mut entry = legacy_entry();
        entry.extra.insert(
            "directory".to_string(),
            Value::String("/custom/dir".to_string()),
        );
        normalize_entry(&mut entry);
        assert_eq!(
            entry.extra.get("directory").and_then(Value::as_str),
            Some("/custom/dir"),
        );
    }

    #[test]
    fn normalize_entry_canonicalizes_legacy_git_type() {
        let mut entry = legacy_entry();
        entry
            .extra
            .insert("git_type".to_string(), Value::String("public".to_string()));
        normalize_entry(&mut entry);
        assert_eq!(
            entry.extra.get("git_type").and_then(Value::as_str),
            Some("remote-public"),
        );
    }

    // ── Step-by-step migration ─────────────────────────────────────────────

    #[test]
    fn migration_plan_lists_one_step_per_missing_piece() {
        let tmp = tempfile::tempdir().unwrap();
        let steps = migration_steps_at(tmp.path(), true).unwrap();
        // Every scaffold file + .claude/settings.json as createFile, plus the
        // gitignore and git-init steps.
        let create: Vec<&str> = steps
            .iter()
            .filter(|s| s.kind == "createFile")
            .filter_map(|s| s.path.as_deref())
            .collect();
        assert_eq!(create.len(), SCAFFOLD_FILES.len() + 1);
        assert!(create.contains(&"AGENTS.md"));
        assert!(create.contains(&".claude/settings.json"));
        let gitignore = steps.iter().find(|s| s.id == "gitignore").unwrap();
        assert!(gitignore.details.contains(&"project.json".to_string()));
        assert!(steps.iter().any(|s| s.id == "git_init"));
    }

    #[test]
    fn migration_plan_offers_a_stub_upgrade_not_a_create_for_a_legacy_doc() {
        let tmp = tempfile::tempdir().unwrap();
        scaffold_project(tmp.path(), false).unwrap();
        std::fs::write(tmp.path().join("CLAUDE.md"), "# Claude Context\n").unwrap();
        let steps = migration_steps_at(tmp.path(), false).unwrap();
        assert_eq!(
            steps,
            vec![MigrationStep {
                id: "stub:CLAUDE.md".to_string(),
                kind: "upgradeStub".to_string(),
                path: Some("CLAUDE.md".to_string()),
                details: vec![],
            }],
            "a complete no-git scaffold with one legacy stub has exactly that one step"
        );
    }

    #[test]
    fn migration_apply_honours_declines_step_by_step() {
        let tmp = tempfile::tempdir().unwrap();
        // Accept only two of the plan's steps; everything declined must stay
        // exactly as it was — including git init.
        let accepted: HashSet<String> = ["file:AGENTS.md".to_string(), "gitignore".to_string()]
            .into_iter()
            .collect();
        let report = apply_migration_steps_at(tmp.path(), true, &accepted).unwrap();
        assert_eq!(report.created_files, vec!["AGENTS.md"]);
        assert!(!report.gitignore_lines_added.is_empty());
        assert!(tmp.path().join(".gitignore").exists());
        assert!(!tmp.path().join("TODO.md").exists(), "declined file created");
        assert!(
            !tmp.path().join(".claude/settings.json").exists(),
            "declined settings created"
        );
        assert!(!report.git_initialized);
        assert!(!tmp.path().join(".git").exists(), "declined git init ran");
    }

    #[test]
    fn migration_apply_rechecks_disk_so_a_stale_accept_never_overwrites() {
        let tmp = tempfile::tempdir().unwrap();
        // Planned as missing, but the user (or an agent) wrote real content
        // before the apply landed — the accepted create must become a no-op.
        std::fs::write(tmp.path().join("AGENTS.md"), "# Agents\n\nReal guidance.\n").unwrap();
        let accepted: HashSet<String> =
            ["file:AGENTS.md".to_string(), "stub:AGENTS.md".to_string()]
                .into_iter()
                .collect();
        let report = apply_migration_steps_at(tmp.path(), false, &accepted).unwrap();
        assert!(report.created_files.is_empty());
        assert!(report.updated_files.is_empty());
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("AGENTS.md")).unwrap(),
            "# Agents\n\nReal guidance.\n",
        );
    }

    #[test]
    fn entry_migration_details_previews_the_normalize_diff() {
        let mut entry = legacy_entry();
        entry
            .extra
            .insert("git_type".to_string(), Value::String("private".to_string()));
        let details = entry_migration_details(&entry);
        assert_eq!(
            details,
            vec![
                concat!("directory → /home/u/", crate::app_slug!(), "/projects/project", crate::app_slug!()).to_string(),
                "git_type: private → remote-private".to_string(),
            ],
        );
        // An already-normalized entry previews no step.
        let mut probe = entry.clone();
        normalize_entry(&mut probe);
        assert!(entry_migration_details(&probe).is_empty());
    }

    // ── scaffold_project ───────────────────────────────────────────────────

    #[test]
    fn scaffold_project_creates_all_files() {
        let tmp = tempfile::tempdir().unwrap();
        scaffold_project(tmp.path(), true).unwrap();

        // Derived from SCAFFOLD_FILES rather than a hand-kept copy, so a file
        // added to the scaffold later is covered here without an edit.
        for (name, _) in SCAFFOLD_FILES {
            assert!(tmp.path().join(name).exists(), "missing: {name}");
        }
        assert!(tmp.path().join(".gitignore").exists());
        assert!(tmp.path().join(".claude/settings.json").exists());
    }

    /// A screen grab holds whatever was on the screen, and a project with a
    /// public remote is one `git add -A` away from publishing it. The default
    /// is what makes a saved shot ignored rather than staged.
    #[test]
    fn scaffold_project_gitignores_screenshots() {
        let dir = tempfile::tempdir().unwrap();
        scaffold_project(dir.path(), true).unwrap();
        let gitignore = fs::read_to_string(dir.path().join(".gitignore")).unwrap();
        assert!(gitignore.lines().any(|line| line == concat!(crate::app_slug!(), "-screenshots/")));
        // The pre-rename folder stays ignored: projects still hold one.
        assert!(gitignore.lines().any(|line| line == "screenshots/"));
    }

    /// A saved attachment is someone's mail, filed into the tree by a user who
    /// wanted to keep it — not to push it to a public remote. Scaffold repair
    /// appends the pattern to projects whose `.gitignore` predates it.
    #[test]
    fn scaffold_project_gitignores_saved_emails() {
        let dir = tempfile::tempdir().unwrap();
        scaffold_project(dir.path(), true).unwrap();
        let gitignore = fs::read_to_string(dir.path().join(".gitignore")).unwrap();
        assert!(gitignore.lines().any(|line| line == concat!(crate::app_slug!(), "-emails/")));
        assert!(gitignore.lines().any(|line| line == "emails/"));
    }

    /// The write paths cannot wait for a scaffold repair that may never be run:
    /// a project whose `.gitignore` predates the folder gets the pattern before
    /// the first file lands in it.
    #[test]
    fn a_project_keeps_the_generated_folder_it_already_has() {
        use crate::brand::{Name, PAIR};
        use crate::services::brand_migration::testing::RENAMED;
        let name = Name::SCREENSHOTS_DIR;
        let (cur, old) = (RENAMED.cur(name), RENAMED.legacy(name).unwrap());

        // Nothing there yet: the current name.
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(generated_dir_name_for(&RENAMED, dir.path(), name), cur);
        // Only the old folder: it is kept.
        fs::create_dir(dir.path().join(&old)).unwrap();
        assert_eq!(generated_dir_name_for(&RENAMED, dir.path(), name), old);
        // Both: the current one.
        fs::create_dir(dir.path().join(&cur)).unwrap();
        assert_eq!(generated_dir_name_for(&RENAMED, dir.path(), name), cur);

        // A link under the old name is not a folder the app made.
        #[cfg(unix)]
        {
            let dir = tempfile::tempdir().unwrap();
            let outside = tempfile::tempdir().unwrap();
            std::os::unix::fs::symlink(outside.path(), dir.path().join(&old)).unwrap();
            assert_eq!(generated_dir_name_for(&RENAMED, dir.path(), name), cur);
        }

        // An unchanged name is answered without a second lookup.
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(generated_dir_name_for(&PAIR, dir.path(), name), PAIR.cur(name));
        assert_eq!(project_generated_dir(dir.path().to_string_lossy().into_owned(), "emails".into()).unwrap(), EMAILS_DIR);
        assert!(project_generated_dir(String::new(), "other".into()).is_err());
    }

    #[test]
    fn ensure_generated_dir_ignored_appends_once_and_only_for_app_folders() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(".gitignore"), "node_modules/\n").unwrap();

        assert!(ensure_generated_dir_ignored(dir.path(), SCREENSHOTS_DIR).unwrap());
        // Idempotent: a second save appends nothing.
        assert!(!ensure_generated_dir_ignored(dir.path(), SCREENSHOTS_DIR).unwrap());
        assert!(ensure_generated_dir_ignored(dir.path(), EMAILS_DIR).unwrap());

        let gitignore = fs::read_to_string(dir.path().join(".gitignore")).unwrap();
        assert_eq!(
            gitignore
                .lines()
                .filter(|l| *l == concat!(crate::app_slug!(), "-screenshots/"))
                .count(),
            1
        );
        assert!(gitignore.lines().any(|line| line == "node_modules/"));

        // Not a folder Tabtivity generates: the file is left alone.
        assert!(!ensure_generated_dir_ignored(dir.path(), "src").unwrap());
        let after = fs::read_to_string(dir.path().join(".gitignore")).unwrap();
        assert!(!after.contains("src"));
    }

    /// No `.gitignore` at all: saving a shot writes the one pattern it needs and
    /// does not quietly scaffold the rest of the project around it.
    #[cfg(unix)]
    #[test]
    fn ensure_generated_dir_ignored_never_writes_through_a_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let victim = dir.path().join("victim");
        fs::write(&victim, "precious\n").unwrap();
        std::os::unix::fs::symlink(&victim, dir.path().join(".gitignore")).unwrap();
        assert!(ensure_generated_dir_ignored(dir.path(), EMAILS_DIR).is_err());
        assert_eq!(fs::read_to_string(&victim).unwrap(), "precious\n");

        // Dangling: `exists()` says no, and a plain write would create the target.
        let dir = tempfile::tempdir().unwrap();
        let elsewhere = dir.path().join("elsewhere");
        std::os::unix::fs::symlink(&elsewhere, dir.path().join(".gitignore")).unwrap();
        assert!(ensure_generated_dir_ignored(dir.path(), EMAILS_DIR).is_err());
        assert!(!elsewhere.exists());
    }

    #[test]
    fn ensure_generated_dir_ignored_creates_a_minimal_file() {
        let dir = tempfile::tempdir().unwrap();
        assert!(ensure_generated_dir_ignored(dir.path(), EMAILS_DIR).unwrap());
        let gitignore = fs::read_to_string(dir.path().join(".gitignore")).unwrap();
        assert_eq!(gitignore, concat!(crate::app_slug!(), "-emails/\n"));
    }

    #[test]
    fn scaffold_project_gitignores_project_json() {
        let tmp = tempfile::tempdir().unwrap();
        scaffold_project(tmp.path(), true).unwrap();

        let content = std::fs::read_to_string(tmp.path().join(".gitignore")).unwrap();
        assert!(
            content.lines().any(|l| l == "project.json"),
            "default .gitignore must exclude project.json"
        );
    }

    #[test]
    fn scaffold_project_does_not_overwrite_existing_files() {
        let tmp = tempfile::tempdir().unwrap();
        let todo_path = tmp.path().join("TODO.md");
        std::fs::write(&todo_path, "original content").unwrap();

        scaffold_project(tmp.path(), true).unwrap();

        let content = std::fs::read_to_string(&todo_path).unwrap();
        assert_eq!(
            content, "original content",
            "existing file must not be overwritten"
        );
    }

    #[test]
    fn scaffold_project_does_not_overwrite_claude_settings() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".claude")).unwrap();
        let cs = tmp.path().join(".claude/settings.json");
        std::fs::write(&cs, r#"{"custom": true}"#).unwrap();

        scaffold_project(tmp.path(), true).unwrap();

        let content = std::fs::read_to_string(&cs).unwrap();
        assert!(
            content.contains("custom"),
            "custom settings must not be overwritten"
        );
    }

    #[test]
    fn scaffold_project_keeps_every_existing_scaffold_file() {
        let tmp = tempfile::tempdir().unwrap();
        let mut ours: Vec<String> = SCAFFOLD_FILES.iter().map(|(n, _)| n.to_string()).collect();
        ours.push(".gitignore".to_string());
        ours.push(".claude/settings.json".to_string());
        std::fs::create_dir_all(tmp.path().join(".claude")).unwrap();
        for name in &ours {
            std::fs::write(tmp.path().join(name), format!("user's own {name}")).unwrap();
        }

        scaffold_project(tmp.path(), true).unwrap();

        for name in &ours {
            assert_eq!(
                std::fs::read_to_string(tmp.path().join(name)).unwrap(),
                format!("user's own {name}"),
                "{name} must survive an import's scaffold"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn scaffold_project_never_writes_through_a_shipped_symlink() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("project");
        std::fs::create_dir(&project).unwrap();
        // A tree can ship a dangling link: `exists()` says false, and a plain
        // write would create the link's target outside the project.
        let outside = tmp.path().join("outside.md");
        std::os::unix::fs::symlink(&outside, project.join("CLAUDE.md")).unwrap();
        let elsewhere = tmp.path().join("elsewhere");
        std::fs::create_dir(&elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, project.join(".claude")).unwrap();

        scaffold_project(&project, false).unwrap();

        assert!(!outside.exists(), "the link's target must not be created");
        assert!(!elsewhere.join("settings.json").exists());
        assert!(std::fs::symlink_metadata(project.join("CLAUDE.md"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(project.join("AGENTS.md").is_file(), "the rest is still scaffolded");
        let preview = scaffold_preview(&project);
        let claude = preview.iter().find(|i| i.path == "CLAUDE.md").unwrap();
        assert!(claude.exists, "the preview must call the kept link present");
    }

    #[test]
    fn claim_new_project_dir_refuses_anything_already_there() {
        let tmp = tempfile::tempdir().unwrap();
        let fresh = tmp.path().join("parent/fresh");
        claim_new_project_dir(&fresh).unwrap();
        assert!(fresh.is_dir());
        assert!(project_folder_exists(fresh.to_string_lossy().to_string()));

        let err = claim_new_project_dir(&fresh).unwrap_err();
        assert!(err.contains("already exists"), "{err}");

        let file = tmp.path().join("a-file");
        std::fs::write(&file, "keep me").unwrap();
        assert!(claim_new_project_dir(&file).is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "keep me");

        assert!(claim_new_project_dir(Path::new("")).is_err());
        assert!(!project_folder_exists(String::new()));
        assert!(!project_folder_exists(
            tmp.path().join("nope").to_string_lossy().to_string()
        ));
    }

    #[cfg(unix)]
    #[test]
    fn claim_new_project_dir_refuses_a_dangling_symlink() {
        let tmp = tempfile::tempdir().unwrap();
        let link = tmp.path().join("link");
        std::os::unix::fs::symlink(tmp.path().join("missing"), &link).unwrap();
        assert!(project_folder_exists(link.to_string_lossy().to_string()));
        assert!(claim_new_project_dir(&link).is_err());
        assert!(!tmp.path().join("missing").exists());
    }

    #[test]
    fn scaffold_project_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        scaffold_project(tmp.path(), true).unwrap();
        scaffold_project(tmp.path(), true).unwrap(); // second call must not error
        assert!(tmp.path().join("TODO.md").exists());
    }

    #[test]
    fn scaffold_project_commits_scaffold_files() {
        let tmp = tempfile::tempdir().unwrap();
        scaffold_project(tmp.path(), true).unwrap();

        // A commit exists (HEAD is born) so lockstep pairing has a tree to check out.
        let head = crate::paths::command_no_window("git")
            .args(["rev-parse", "--verify", "HEAD"])
            .current_dir(tmp.path())
            .output()
            .unwrap();
        assert!(
            head.status.success(),
            "scaffold must create an initial commit"
        );

        // The .claude settings and docs are TRACKED, not just present on disk — that
        // is what lets `extend` seed them onto the remote via the lockstep bundle.
        for path in &[".claude/settings.json", "CLAUDE.md", ".gitignore"] {
            let tracked = crate::paths::command_no_window("git")
                .args(["ls-files", "--error-unmatch", path])
                .current_dir(tmp.path())
                .output()
                .unwrap();
            assert!(tracked.status.success(), "{path} must be tracked by git");
        }
        assert!(
            !git_head_unborn(tmp.path()),
            "HEAD must be born after scaffold"
        );
    }

    #[test]
    fn scaffold_project_without_git_skips_init() {
        let tmp = tempfile::tempdir().unwrap();
        scaffold_project(tmp.path(), false).unwrap();
        // Scaffold files are still written, but no git repo is initialized.
        assert!(tmp.path().join("TODO.md").exists());
        assert!(tmp.path().join(".claude/settings.json").exists());
        assert!(
            !tmp.path().join(".git").exists(),
            "git must not be initialized when with_git is false"
        );
    }

    #[test]
    fn scaffold_project_without_git_skips_gitignore() {
        let tmp = tempfile::tempdir().unwrap();
        scaffold_project(tmp.path(), false).unwrap();
        // No git → no `.gitignore` (it's a git-axis artifact), but the docs and
        // .claude settings are still written.
        assert!(
            !tmp.path().join(".gitignore").exists(),
            ".gitignore must not be written for a no-git project"
        );
        assert!(tmp.path().join("TODO.md").exists());
        assert!(tmp.path().join(".claude/settings.json").exists());
    }

    #[test]
    fn scaffold_preview_reports_git_directory_status() {
        let tmp = tempfile::tempdir().unwrap();

        let missing = scaffold_preview(tmp.path())
            .into_iter()
            .find(|item| item.path == ".git")
            .expect(".git preview item");
        assert!(!missing.exists);
        assert_eq!(missing.kind, "directory");

        std::fs::create_dir_all(tmp.path().join(".git")).unwrap();
        let present = scaffold_preview(tmp.path())
            .into_iter()
            .find(|item| item.path == ".git")
            .expect(".git preview item");
        assert!(present.exists);
        assert_eq!(present.kind, "directory");
    }

    // ── repair_project_scaffold_at ─────────────────────────────────────────

    #[test]
    fn repair_fills_missing_scaffold_docs_and_settings() {
        let tmp = tempfile::tempdir().unwrap();
        // Simulate a project scaffolded before DOCUMENTATION.md / .claude
        // settings existed: only a couple of the current scaffold files.
        std::fs::write(tmp.path().join("TODO.md"), "# TODO\n").unwrap();
        std::fs::write(tmp.path().join(".gitignore"), "node_modules/\n").unwrap();

        let report = repair_project_scaffold_at(tmp.path(), false).unwrap();

        assert!(report.created_files.contains(&"AGENTS.md".to_string()));
        assert!(report
            .created_files
            .contains(&".claude/settings.json".to_string()));
        assert!(!report.created_files.contains(&"TODO.md".to_string()));
        assert!(tmp.path().join("DOCUMENTATION.md").exists());
        assert!(tmp.path().join(".claude/settings.json").exists());
    }

    #[test]
    fn repair_merges_missing_gitignore_lines_without_clobbering() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(".gitignore"), "# my custom rule\nfoo/\n").unwrap();

        // `.gitignore` is a git-axis artifact, so the merge only runs for
        // git-backed projects.
        let report = repair_project_scaffold_at(tmp.path(), true).unwrap();

        assert!(report
            .gitignore_lines_added
            .contains(&"project.json".to_string()));
        let content = std::fs::read_to_string(tmp.path().join(".gitignore")).unwrap();
        assert!(content.contains("# my custom rule"));
        assert!(content.contains("foo/"));
        assert!(content.lines().any(|l| l == "project.json"));
    }

    #[test]
    fn repair_without_git_does_not_touch_gitignore() {
        let tmp = tempfile::tempdir().unwrap();
        // A no-git project missing `.gitignore` entirely.
        let report = repair_project_scaffold_at(tmp.path(), false).unwrap();

        assert!(
            !tmp.path().join(".gitignore").exists(),
            "no-git repair must not create a .gitignore"
        );
        assert!(report.gitignore_lines_added.is_empty());
        // Docs/settings are still filled in as usual.
        assert!(tmp.path().join("DOCUMENTATION.md").exists());
        assert!(tmp.path().join(".claude/settings.json").exists());
    }

    #[test]
    fn repair_is_a_noop_when_scaffold_is_already_current() {
        let tmp = tempfile::tempdir().unwrap();
        scaffold_project(tmp.path(), false).unwrap();

        let report = repair_project_scaffold_at(tmp.path(), false).unwrap();

        assert!(report.is_empty());
    }

    /// PROJECT.md is the navigation hub: a scaffold file it does not link is
    /// unreachable by walking the map. Checked against `SCAFFOLD_FILES` rather
    /// than a hand-kept list, so adding a scaffold file (REMARKS.md was the
    /// one that slipped through) fails here until the map links it too.
    #[test]
    fn project_map_links_every_scaffold_file() {
        let tmp = tempfile::tempdir().unwrap();
        scaffold_project(tmp.path(), true).unwrap();

        let map = std::fs::read_to_string(tmp.path().join("PROJECT.md")).unwrap();
        for (name, _) in SCAFFOLD_FILES {
            if *name == "PROJECT.md" {
                continue; // the map does not link itself
            }
            assert!(
                map.contains(&format!("(./{name})")),
                "PROJECT.md missing link to {name}"
            );
        }
        // The config files are scaffolded outside SCAFFOLD_FILES but belong on
        // the map all the same.
        for link in &["(./.claude/settings.json)", "(./.gitignore)"] {
            assert!(map.contains(link), "PROJECT.md missing link {link}");
        }
    }

    #[test]
    fn agent_docs_point_at_agents_md_and_link_each_other() {
        let tmp = tempfile::tempdir().unwrap();
        scaffold_project(tmp.path(), false).unwrap();

        let agents = std::fs::read_to_string(tmp.path().join("AGENTS.md")).unwrap();
        // AGENTS.md carries the instructions and points at the map; it is
        // loaded every session, so it doesn't repeat the map's links.
        assert!(agents.contains("(./PROJECT.md)"), "AGENTS.md must link PROJECT.md");
        for link in &["(./README.md)", "(./TODO.md)", "(./AGENTS.md)"] {
            assert!(!agents.contains(link), "AGENTS.md repeats the map: {link}");
        }
        assert!(!agents.contains(concat!(crate::app_slug!(), "-send")), concat!(crate::app_name!(), "'s own hint is not the project's"));

        // The agent-specific docs carry no instructions of their own: each
        // imports AGENTS.md and links the other agent files.
        for (name, sibling) in &[
            ("CLAUDE.md", "(./GEMINI.md)"),
            ("GEMINI.md", "(./CLAUDE.md)"),
        ] {
            let doc = std::fs::read_to_string(tmp.path().join(name)).unwrap();
            assert!(
                doc.lines().any(|l| l.trim() == "@AGENTS.md"),
                "{name} must import AGENTS.md"
            );
            assert!(doc.contains("(./AGENTS.md)"), "{name} must link AGENTS.md");
            assert!(doc.contains(sibling), "{name} must link {sibling}");
        }
    }

    #[test]
    fn legacy_stub_detection_only_matches_untouched_agent_docs() {
        assert!(is_legacy_agent_stub("CLAUDE.md", "# Claude Context\n"));
        assert!(is_legacy_agent_stub("AGENTS.md", "# Agents\n"));
        assert!(is_legacy_agent_stub("GEMINI.md", "   \n"));
        // Real content, a non-agent doc, and the current template all fail.
        assert!(!is_legacy_agent_stub(
            "CLAUDE.md",
            "# Claude Context\n\nRun `make test`.\n"
        ));
        assert!(!is_legacy_agent_stub("TODO.md", "# TODO\n"));
        assert!(!is_legacy_agent_stub("AGENTS.md", AGENTS_SCAFFOLD));
    }

    #[test]
    fn legacy_agent_stubs_mark_an_otherwise_complete_scaffold_missing() {
        let tmp = tempfile::tempdir().unwrap();
        scaffold_project(tmp.path(), true).unwrap();
        assert!(!scaffold_is_missing_at(tmp.path(), true));

        // Die Crew predates AGENTS.md being canonical and has exactly these
        // untouched placeholders. They must keep the visible warning on until
        // the user repairs the project scaffold.
        for (name, content) in LEGACY_AGENT_STUBS {
            std::fs::write(tmp.path().join(name), content).unwrap();
        }

        assert!(scaffold_is_missing_at(tmp.path(), true));
        repair_project_scaffold_at(tmp.path(), true).unwrap();
        assert!(!scaffold_is_missing_at(tmp.path(), true));
    }

    #[test]
    fn untouched_earlier_agents_templates_are_upgraded_and_edited_ones_kept() {
        for old in AGENTS_HISTORY {
            assert_ne!(*old, AGENTS_SCAFFOLD);
            let tmp = tempfile::tempdir().unwrap();
            scaffold_project(tmp.path(), false).unwrap();
            std::fs::write(tmp.path().join("AGENTS.md"), old.replace('\n', "\r\n")).unwrap();
            assert!(scaffold_is_missing_at(tmp.path(), false));
            let report = repair_project_scaffold_at(tmp.path(), false).unwrap();
            assert_eq!(report.updated_files, vec!["AGENTS.md".to_string()]);
            assert_eq!(std::fs::read_to_string(tmp.path().join("AGENTS.md")).unwrap(), AGENTS_SCAFFOLD);

            let edited = format!("{old}\n## Mine\n");
            std::fs::write(tmp.path().join("AGENTS.md"), &edited).unwrap();
            assert!(!scaffold_is_missing_at(tmp.path(), false));
            repair_project_scaffold_at(tmp.path(), false).unwrap();
            assert_eq!(std::fs::read_to_string(tmp.path().join("AGENTS.md")).unwrap(), edited);
        }
    }

    /// Pins the shipped `AGENTS.md` template. When this fails, the template
    /// changed: copy the *previous* text byte for byte into
    /// `scaffold_history/AGENTS.<date>.md`, add it to `AGENTS_HISTORY`, then
    /// update the pin — otherwise every project scaffolded with it keeps it.
    #[test]
    fn the_agents_template_is_pinned_so_its_predecessor_stays_upgradable() {
        let fnv1a = AGENTS_SCAFFOLD.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |h, b| {
            (h ^ u64::from(b)).wrapping_mul(0x0000_0100_0000_01b3)
        });
        assert_eq!(fnv1a, 0x75197758527454ff, "AGENTS_SCAFFOLD changed; see this test's doc");
    }

    #[test]
    fn repair_upgrades_untouched_legacy_agent_stubs() {
        let tmp = tempfile::tempdir().unwrap();
        // A project scaffolded before AGENTS.md became canonical: three stubs,
        // one of which the user has since written real content into.
        std::fs::write(tmp.path().join("AGENTS.md"), "# Agents\n").unwrap();
        std::fs::write(tmp.path().join("CLAUDE.md"), "# Claude Context\n").unwrap();
        std::fs::write(tmp.path().join("GEMINI.md"), "# Gemini Context\n\nMine.\n").unwrap();

        let report = repair_project_scaffold_at(tmp.path(), false).unwrap();

        assert!(report.updated_files.contains(&"AGENTS.md".to_string()));
        assert!(report.updated_files.contains(&"CLAUDE.md".to_string()));
        assert!(
            !report.updated_files.contains(&"GEMINI.md".to_string()),
            "a doc the user wrote must never be overwritten"
        );
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("GEMINI.md")).unwrap(),
            "# Gemini Context\n\nMine.\n"
        );
        assert!(std::fs::read_to_string(tmp.path().join("CLAUDE.md"))
            .unwrap()
            .contains("@AGENTS.md"));
    }

    #[test]
    fn repair_leaves_current_agent_docs_alone() {
        let tmp = tempfile::tempdir().unwrap();
        scaffold_project(tmp.path(), false).unwrap();

        let report = repair_project_scaffold_at(tmp.path(), false).unwrap();

        assert!(report.updated_files.is_empty());
        assert!(report.is_empty());
    }

    #[test]
    fn repair_initializes_git_when_missing_and_requested() {
        let tmp = tempfile::tempdir().unwrap();

        let report = repair_project_scaffold_at(tmp.path(), true).unwrap();

        assert!(report.git_initialized);
        assert!(tmp.path().join(".git").is_dir());
    }

    #[test]
    fn adopted_project_json_loses_every_executable_intent_field() {
        let mut project = Project {
            id: "old".to_string(),
            name: "Hostile".to_string(),
            directory: "/somewhere".to_string(),
            description: Some("keep me".to_string()),
            git_type: Some("local".to_string()),
            created_at: Some("2020-01-01".to_string()),
            open_apps: Some(vec![crate::schema::project::OpenApp {
                exec: "/tmp/pwn.sh".to_string(),
                file: None,
                mode: Some("standalone".to_string()),
                opened_at: None,
                pid: None,
                extra: Default::default(),
            }]),
            tab_layout: Some(vec![crate::schema::project::TabEntry {
                key: "t1".to_string(),
                label: "Shell".to_string(),
                cmd: "/tmp/pwn.sh".to_string(),
                cwd: "/".to_string(),
                session_id: None,
                extra: Default::default(),
            }]),
            tab_groups: Some(serde_json::json!({ "type": "group" })),
            open_tab_sessions: Some(serde_json::json!(["uuid"])),
            sandbox: Some(SandboxSpec {
                enabled: true,
                dockerfile: Some("Dockerfile".to_string()),
                network: Some("host".to_string()),
                ..Default::default()
            }),
            default_apps: Some(HashMap::from([(
                ".md".to_string(),
                "/tmp/pwn.sh".to_string(),
            )])),
            python_interpreter: Some("./pwn".to_string()),
            ..Default::default()
        };

        strip_untrusted_project_fields(&mut project);

        assert!(project.open_apps.is_none());
        assert!(project.tab_layout.is_none());
        assert!(project.tab_groups.is_none());
        assert!(project.open_tab_sessions.is_none());
        assert!(project.sandbox.is_none());
        assert!(project.default_apps.is_none());
        assert!(project.python_interpreter.is_none());
        // Descriptive fields survive — the import still adopts the metadata.
        assert_eq!(project.description.as_deref(), Some("keep me"));
        assert_eq!(project.git_type.as_deref(), Some("local"));
        assert_eq!(project.created_at.as_deref(), Some("2020-01-01"));
    }
}

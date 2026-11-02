//! Remote → Remote-only conversion (`docs/remote_only_projects_plan.md` E8):
//! a plain Remote project stops keeping its local mirror. The reverse
//! (Remote-only → Remote) is `set_remote_mirror_dir` with `keepLocalCopy`.
//!
//! The mirror folder is **never deleted** (D8). An explicit-path mirror stays
//! where it is, now a plain folder; one inside the state dir (the old default
//! location, which nothing would point at any more and a later state-dir
//! cleanup could take with it) is moved out to the projects-ssh root as
//! `<name> (local copy)`, and that path is returned.
//!
//! The conversion is refused unless the preview found nothing that lives only
//! in the mirror: commits or uncommitted changes the host lacks, byte-sync
//! edits not pushed, or a tab running on this computer. The commit re-runs the
//! whole preview under the project's mutation lock (`services::sync_op`) and
//! refuses when its fingerprint differs from the one the user confirmed, so a
//! lockstep pass, an edit or a new tab between the two can never slip through.
//! VM projects are refused both ways in v1 (plan, "Prior art").

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use crate::commands::projects::{entry_is_vm, move_tree, patch_project_entry_mirrored, sanitize_name};
use crate::schema::project::RemoteSpec;
use crate::schema::projects::ProjectEntry;
use crate::services::git_peer::{self, Peer, PeerSnapshot};
use crate::services::remote::{self, RemotePoolState};
use crate::services::remote_sync::{self, SyncManifestState};
use crate::services::sync_auto::AutoSyncState;
use crate::tauri_host::Ctx;

/// The refusal when the mirror moved on since the preview the user confirmed
/// (`{UPPER}_MIRROR_CHANGED: …`): the cockpit re-runs the preview.
pub fn mirror_changed_refusal() -> String {
    format!(
        "{}_MIRROR_CHANGED: the local copy changed since the preview; review it again",
        crate::brand::UPPER
    )
}

/// What stopping the local copy would leave behind, for the confirm. Every
/// count is a blocker except `stoppedWorkers`, which the confirm only names.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnpairPreview {
    /// Lockstep was on for this project.
    pub lockstep_enabled: bool,
    /// The mirror holds a git repository.
    pub mirror_is_repo: bool,
    /// Commits reachable from the mirror's branches and tags that the host
    /// does not have.
    pub commits_not_on_host: u64,
    /// `git status --porcelain` entries in the mirror (tracked changes and
    /// untracked files): work that exists only in this folder.
    pub uncommitted: u64,
    /// Byte-synced files edited in the mirror since their last transfer.
    pub unpushed_sync_edits: u64,
    /// Saved tabs of the project that run on this computer (an agent or shell
    /// in the mirror, a local-model tab): move them to the host first.
    pub local_tabs: u64,
    /// Synced-copy workers (`sync_code && !shared_fs`) that stop receiving
    /// code, by display label.
    pub stopped_workers: Vec<String>,
    /// The mirror folder today.
    pub mirror_path: String,
    pub mirror_exists: bool,
    /// Where the folder ends up: the same path, or the moved-out one.
    pub kept_at: String,
    /// The folder is moved out of the state dir (`kept_at` differs).
    pub moves: bool,
    /// Hash over the mirror's refs, its `git status`, `sync.json` and the
    /// counts above; the conversion is refused when it changed.
    pub fingerprint: String,
}

impl UnpairPreview {
    /// Whether anything still lives only in the mirror.
    pub fn blocked(&self) -> bool {
        self.commits_not_on_host > 0 || self.uncommitted > 0 || self.unpushed_sync_edits > 0 || self.local_tabs > 0
    }
}

/// What a finished conversion reports.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnpairOutcome {
    /// The registry entry as it now reads (remote-only, no `mirror`).
    pub entry: ProjectEntry,
    /// Where the old mirror folder is now (empty when there was none).
    pub kept_at: String,
    /// The folder was moved out of the state dir.
    pub moved: bool,
    /// The move out failed; the folder is still at `kept_at` (its old place).
    pub move_error: Option<String>,
}

/// Why `entry` cannot be converted to remote-only, or `None`. Pure.
pub fn unpair_refusal(entry: &ProjectEntry) -> Option<String> {
    let Some(spec) = remote::spec_from_entry(entry) else {
        return Some("not a remote project".to_string());
    };
    if entry_is_vm(entry) || crate::services::vm::is_vm_spec(&spec) {
        return Some("a VM project cannot change whether it keeps a local copy in this version".to_string());
    }
    if spec.is_remote_only() {
        return Some(remote::remote_only_refusal("this project already keeps no local copy"));
    }
    None
}

/// Why the reverse (Remote-only → Remote, `set_remote_mirror_dir` with
/// `keepLocalCopy`) is refused for `entry`, or `None`. Pure.
pub fn keep_local_copy_refusal(entry: &ProjectEntry) -> Option<String> {
    let Some(spec) = remote::spec_from_entry(entry) else {
        return Some("not a remote project".to_string());
    };
    (entry_is_vm(entry) || crate::services::vm::is_vm_spec(&spec))
        .then(|| "a VM project cannot change whether it keeps a local copy in this version".to_string())
}

/// Whether a saved tab of `kind` at `location` runs on this computer on a
/// plain Remote project: the window's `effectiveTabLocation` without the pin
/// (agents default local, shells default to the host, a local-model tab is
/// always local; the other kinds run nothing). Pure.
pub fn tab_runs_here(kind: &str, location: Option<&str>) -> bool {
    match kind {
        "local_agent" => true,
        "agent" | "shell" => match location {
            Some(location) => location == "local",
            None => kind == "agent",
        },
        _ => false,
    }
}

/// Pin one saved tab to the primary host for the Remote-only → Remote
/// conversion: an agent or shell tab whose `location` names no host (unset,
/// `"local"`, or not a string) ran on the primary under the pin, and must keep
/// running there once agents default to the mirror again. `true` when it
/// changed. Pure.
pub fn pin_saved_tab_to_host(extra: &mut std::collections::HashMap<String, Value>) -> bool {
    let locatable = matches!(extra.get("kind").and_then(Value::as_str), Some("agent" | "shell"));
    let on_host = extra
        .get("location")
        .and_then(Value::as_str)
        .is_some_and(|l| l == "remote" || l.starts_with("host:"));
    if !locatable || on_host {
        return false;
    }
    extra.insert("location".to_string(), Value::String("remote".to_string()));
    true
}

/// [`pin_saved_tab_to_host`] over the project's saved layout (the window pins
/// its live tabs itself, `pinScopeTabsToHost`).
pub(crate) fn pin_saved_tabs_to_host(project_id: &str, local_file: &str) -> Result<(), String> {
    let session = crate::services::terminal_service::load_terminal_session(project_id);
    // project-tree-read: ok — the state-dir `TerminalSession`, read by project id.
    let mut probe = session.tab_layout.clone();
    if !probe.iter_mut().any(|t| pin_saved_tab_to_host(&mut t.extra)) {
        return Ok(());
    }
    crate::services::workspace::edit(project_id, local_file, |session| {
        // project-tree-read: ok — the state-dir `TerminalSession`, edited by project id.
        for tab in session.tab_layout.iter_mut() {
            pin_saved_tab_to_host(&mut tab.extra);
        }
        Ok(())
    })
    .map(|_| ())
}

/// How many of the project's saved tabs run on this computer.
fn local_tab_count(project_id: &str) -> u64 {
    crate::services::terminal_service::load_terminal_session(project_id)
        // project-tree-read: ok — the state-dir `TerminalSession`, read by project id.
        .tab_layout
        .iter()
        .filter(|tab| {
            let kind = tab.extra.get("kind").and_then(Value::as_str).unwrap_or("");
            let location = tab.extra.get("location").and_then(Value::as_str);
            tab_runs_here(kind, location)
        })
        .count() as u64
}

/// The entries of a `git status --porcelain=v1 -z` output. A rename or copy
/// carries its source path as a second NUL field, which is not an entry. Pure.
pub fn porcelain_z_entries(out: &[u8]) -> u64 {
    let mut fields = out.split(|b| *b == 0).filter(|f| !f.is_empty());
    let mut n = 0;
    while let Some(field) = fields.next() {
        n += 1;
        let xy = &field[..field.len().min(2)];
        if xy.iter().any(|c| *c == b'R' || *c == b'C') {
            let _ = fields.next();
        }
    }
    n
}

/// The tips whose commits must already be on the host: every branch, a
/// detached HEAD, and each tag the host does not hold by the same name and
/// object. Deduplicated, in order. Pure.
pub fn local_tips(local: &PeerSnapshot, host: &PeerSnapshot) -> Vec<String> {
    let host_tags: HashSet<(&str, &str)> = host.tags.iter().map(|t| (t.name.as_str(), t.sha.as_str())).collect();
    let mut seen = HashSet::new();
    let mut tips = Vec::new();
    let detached = match &local.head {
        Some(git_peer::HeadRef::Detached { sha }) => Some(sha.clone()),
        _ => None,
    };
    let candidates = local
        .branches
        .iter()
        .map(|b| b.sha.clone())
        .chain(detached)
        .chain(local.tags.iter().filter(|t| !host_tags.contains(&(t.name.as_str(), t.sha.as_str()))).map(|t| t.sha.clone()));
    for sha in candidates {
        if seen.insert(sha.clone()) {
            tips.push(sha);
        }
    }
    tips
}

/// Commits in the mirror the host lacks: `rev-list --count` from the tips the
/// host does not know, excluding everything reachable from the ones it does
/// and from the host's own tips the mirror holds. A failed query is an error
/// (the caller refuses), never zero.
fn commits_not_on_host(local: &Peer, host: &Peer, lsnap: &PeerSnapshot, hsnap: &PeerSnapshot) -> Result<u64, String> {
    let tips = local_tips(lsnap, hsnap);
    if tips.is_empty() {
        return Ok(0);
    }
    let host_has: HashSet<String> = git_peer::known_shas(host, &tips).into_iter().collect();
    let missing: Vec<&String> = tips.iter().filter(|t| !host_has.contains(*t)).collect();
    if missing.is_empty() {
        return Ok(0);
    }
    let host_tips: Vec<String> = hsnap.branches.iter().chain(hsnap.tags.iter()).map(|r| r.sha.clone()).collect();
    let mut exclude: Vec<String> = host_has.into_iter().collect();
    exclude.extend(git_peer::known_shas(local, &host_tips));
    let mut args: Vec<&str> = vec!["rev-list", "--count"];
    args.extend(missing.iter().map(|s| s.as_str()));
    if !exclude.is_empty() {
        args.push("--not");
        args.extend(exclude.iter().map(String::as_str));
    }
    let out = local.run(&args)?;
    if !out.status.success() {
        return Err(format!(
            "could not count the local copy's commits: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse()
        .map_err(|_| "could not count the local copy's commits".to_string())
}

/// Byte-synced files edited in the mirror since their recorded base, by the
/// same local-side rule auto-sync pushes on (`remote_sync::divergence`). A
/// path that cannot be looked at (a link, a special file, a refused path)
/// counts as edited.
fn unpushed_sync_edits(manifest: &remote_sync::Manifest, mirror: &Path) -> u64 {
    manifest
        .iter()
        .filter(|(rel, e)| e.selected && !e.is_dir && !remote_sync::is_excluded(manifest, rel, ""))
        .filter(|(rel, e)| match remote_sync::mirror_lstat(mirror, rel) {
            Ok(remote_sync::MirrorStat::File(m)) => remote_sync::divergence(e, None, Some(remote_sync::local_meta(&m))).1,
            Ok(remote_sync::MirrorStat::Missing) => remote_sync::divergence(e, None, None).1,
            _ => true,
        })
        .count() as u64
}

/// The mirror folder of a plain Remote `entry`: its explicit `extra["mirror"]`,
/// else the default under `state_dir`.
fn mirror_of(entry: &ProjectEntry, state_dir: &Path) -> Option<PathBuf> {
    remote::local_copy_in(entry, state_dir)
}

/// Where the folder `mirror` ends up: unchanged unless it lies inside
/// `state_dir`, then `<ssh_root>/<name> (local copy)` with ` 2`, ` 3`… when
/// that is `taken`. `None` when no free name was found. Pure but for `taken`.
pub fn kept_destination(
    mirror: &Path,
    state_dir: &Path,
    ssh_root: &Path,
    name: &str,
    project_id: &str,
    taken: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    if !inside(mirror, state_dir) {
        return Some(mirror.to_path_buf());
    }
    let safe = sanitize_name(name);
    let leaf = if safe.is_empty() { project_id.to_string() } else { safe };
    (1..1000u32)
        .map(|n| {
            let suffix = if n == 1 { String::new() } else { format!(" {n}") };
            ssh_root.join(format!("{leaf} (local copy){suffix}"))
        })
        .find(|candidate| !taken(candidate))
}

/// Whether `path` is `dir` or below it, also after resolving links.
fn inside(path: &Path, dir: &Path) -> bool {
    if path.starts_with(dir) {
        return true;
    }
    match (std::fs::canonicalize(path), std::fs::canonicalize(dir)) {
        (Ok(p), Ok(d)) => p.starts_with(d),
        _ => false,
    }
}

/// A destination already in use: on disk, or registered as some project's
/// folder or mirror.
fn destination_taken(list: &crate::schema::projects::ProjectsList, path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
        || crate::commands::projects::find_project_conflict(list, &crate::commands::projects::ProjectSite::Local { dir: &path.to_string_lossy() }, None).is_some()
}

/// The preview's inputs that are read from this machine, hashed together with
/// the counts: the mirror path, its refs signature, its raw `git status -z`,
/// and `sync.json`'s size and mtime.
fn fingerprint(mirror: &Path, local_sig: &str, porcelain: &[u8], project_id: &str, counts: &UnpairPreview) -> String {
    let manifest = std::fs::metadata(remote_sync::manifest_path(project_id))
        .map(|m| {
            let mtime = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            format!("{}:{mtime}", m.len())
        })
        .unwrap_or_else(|_| "absent".to_string());
    let mut bytes = Vec::new();
    for part in [
        mirror.to_string_lossy().as_bytes(),
        local_sig.as_bytes(),
        porcelain,
        manifest.as_bytes(),
        format!(
            "{}:{}:{}:{}:{}:{}",
            counts.commits_not_on_host,
            counts.uncommitted,
            counts.unpushed_sync_edits,
            counts.local_tabs,
            counts.lockstep_enabled,
            counts.stopped_workers.join("\u{1f}")
        )
        .as_bytes(),
    ] {
        bytes.extend_from_slice(&(part.len() as u64).to_le_bytes());
        bytes.extend_from_slice(part);
    }
    crate::digest::sha256_hex(&bytes)
}

/// The whole preview, blocking: local git, one bounded host probe, the
/// manifest and the saved layout. Refuses (never answers zero) when either
/// side's git or the manifest cannot be read.
fn preview_blocking(project_id: &str) -> Result<UnpairPreview, String> {
    let entry = remote::project_entry(project_id)?;
    if let Some(refusal) = unpair_refusal(&entry) {
        return Err(refusal);
    }
    let spec: RemoteSpec = remote::spec_from_entry(&entry).ok_or_else(|| "not a remote project".to_string())?;
    let state_dir = crate::storage::state_dir();
    let mirror = mirror_of(&entry, &state_dir).ok_or_else(|| "this project has no local copy".to_string())?;
    let mut preview = UnpairPreview {
        lockstep_enabled: git_peer::load_state(project_id).enabled,
        mirror_path: mirror.to_string_lossy().into_owned(),
        mirror_exists: mirror.is_dir(),
        stopped_workers: remote::compute_hosts_for(project_id)
            .iter()
            .filter(|h| h.sync_code && !h.shared_fs)
            .map(|h| h.display_label().to_string())
            .collect(),
        local_tabs: local_tab_count(project_id),
        ..Default::default()
    };
    let mut local_sig = String::from("no-mirror");
    let mut porcelain = Vec::new();
    if preview.mirror_exists {
        let local = Peer::Local(mirror.clone());
        let lsnap = git_peer::probe(&local);
        if lsnap.probe_error {
            return Err("could not read the local copy's git state; nothing was changed".to_string());
        }
        local_sig = git_peer::refs_signature(&lsnap);
        preview.mirror_is_repo = lsnap.is_repo;
        if lsnap.is_repo {
            let host = Peer::Remote(spec.clone());
            let hsnap = git_peer::probe(&host);
            if hsnap.probe_error {
                return Err("could not read the host's git state; nothing was changed".to_string());
            }
            preview.commits_not_on_host = commits_not_on_host(&local, &host, &lsnap, &hsnap)?;
            let out = local.run(&["status", "--porcelain=v1", "-z"])?;
            if !out.status.success() {
                return Err("could not read the local copy's git status; nothing was changed".to_string());
            }
            porcelain = out.stdout;
            preview.uncommitted = porcelain_z_entries(&porcelain);
        }
        let manifest = remote_sync::load_manifest(project_id)?;
        preview.unpushed_sync_edits = unpushed_sync_edits(&manifest, &mirror);
    }
    let list = crate::commands::projects::read_projects_list()?;
    let kept = kept_destination(
        &mirror,
        &state_dir,
        &crate::paths::projects_ssh_root(),
        &entry.name,
        project_id,
        |p| destination_taken(&list, p),
    )
    .ok_or_else(|| "no free folder name to keep the local copy under".to_string())?;
    preview.moves = kept != mirror && preview.mirror_exists;
    preview.kept_at = if preview.mirror_exists { kept.to_string_lossy().into_owned() } else { String::new() };
    preview.fingerprint = fingerprint(&mirror, &local_sig, &porcelain, project_id, &preview);
    Ok(preview)
}

/// Preview "Stop keeping a local copy" for a plain Remote project. Needs the
/// connected host (the lockstep probe asks it which commits it has) and
/// refuses at once, without dialing, while disconnected.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn remote_unpair_mirror_preview(ctx: Ctx, project_id: String) -> Result<UnpairPreview, String> {
    let pool = ctx.get::<RemotePoolState>();
    if !remote::is_connected(pool, &project_id).await {
        return Err("the project is not connected; connect first".to_string());
    }
    app_core::rt::try_blocking("project", move || preview_blocking(&project_id)).await
}

/// What [`apply_unpair_blocking`] recorded, for the move-out.
pub struct UnpairPlan {
    pub entry: ProjectEntry,
    pub mirror: PathBuf,
    pub kept_at: Option<PathBuf>,
}

/// The registry half of the conversion, under the caller's mutation lock:
/// `remote_only: true` in both copies, `mirror` and a `"local"` run host
/// dropped, and the host-bound state files (`sync.json`, `git_peer.json`)
/// removed. `local_loss.json` survives, as on detach. `mirror` is the folder
/// the preview saw; a registry that now names another one is refused.
pub fn apply_unpair_blocking(project_id: &str, mirror: &Path) -> Result<UnpairPlan, String> {
    let state_dir = crate::storage::state_dir();
    let expected = mirror.to_path_buf();
    // Set once the registry write itself went through: only then may an error
    // (the display copy's rewrite) be passed over.
    let registry_written = std::cell::Cell::new(false);
    let written = patch_project_entry_mirrored(
        project_id,
        |entry| {
            if let Some(refusal) = unpair_refusal(entry) {
                return Err(refusal);
            }
            if mirror_of(entry, &state_dir).as_deref() != Some(expected.as_path()) {
                return Err(mirror_changed_refusal());
            }
            let remote = entry
                .extra
                .get_mut("remote")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| "not a remote project".to_string())?;
            remote.insert("remote_only".to_string(), Value::Bool(true));
            entry.extra.remove("mirror");
            if entry.extra.get("run_host").and_then(Value::as_str) == Some("local") {
                entry.extra.remove("run_host");
            }
            registry_written.set(true);
            Ok(entry.clone())
        },
        |project, _| {
            if let Some(remote) = project.remote.as_mut() {
                remote.remote_only = Some(true);
            }
            project.mirror = None;
            if project.run_host.as_deref() == Some("local") {
                project.run_host = None;
            }
        },
    );
    let entry = match written {
        Ok(entry) => entry,
        // The registry is the record; a display copy that could not be
        // rewritten is stale, not a reason to stop half-way.
        Err(e) if !registry_written.get() => return Err(e),
        Err(e) => match remote::project_entry(project_id) {
            Ok(entry) if remote::entry_is_remote_only(&entry) && !entry.extra.contains_key("mirror") => {
                eprintln!("remote_unpair_mirror: {project_id}: {e}");
                entry
            }
            _ => return Err(e),
        },
    };
    crate::commands::projects::clear_host_bound_files(project_id);
    let kept_at = if mirror.is_dir() {
        let list = crate::commands::projects::read_projects_list()?;
        kept_destination(
            mirror,
            &state_dir,
            &crate::paths::projects_ssh_root(),
            &entry.name,
            project_id,
            |p| destination_taken(&list, p),
        )
    } else {
        None
    };
    Ok(UnpairPlan { entry, mirror: mirror.to_path_buf(), kept_at })
}

/// Move the old mirror out of the state dir when the plan says so. Never
/// deletes: `move_tree` removes the source only after a cross-device copy
/// (`.git` included) finished, and a failure leaves the folder where it was.
pub fn move_out_blocking(plan: UnpairPlan) -> UnpairOutcome {
    let UnpairPlan { entry, mirror, kept_at } = plan;
    let Some(dest) = kept_at else {
        let kept = if mirror.is_dir() { mirror.to_string_lossy().into_owned() } else { String::new() };
        let move_error = (!kept.is_empty() && inside(&mirror, &crate::storage::state_dir()))
            .then(|| "no free folder name to move the local copy to".to_string());
        return UnpairOutcome { entry, kept_at: kept, moved: false, move_error };
    };
    if dest == mirror {
        return UnpairOutcome { entry, kept_at: mirror.to_string_lossy().into_owned(), moved: false, move_error: None };
    }
    match move_tree(&mirror, &dest) {
        Ok(()) => UnpairOutcome { entry, kept_at: dest.to_string_lossy().into_owned(), moved: true, move_error: None },
        Err(e) => {
            eprintln!("remote_unpair_mirror: moving '{}' out failed: {e}", mirror.display());
            // A cross-device copy that failed half-way leaves a partial copy
            // at `dest` and the whole original in place: report the original.
            UnpairOutcome { entry, kept_at: mirror.to_string_lossy().into_owned(), moved: false, move_error: Some(e) }
        }
    }
}

/// Stop keeping a local copy of a plain Remote project (E8). `expect` is the
/// fingerprint of the preview the user confirmed. Needs the connected host,
/// because the whole preview runs again under the project's mutation lock; it
/// refuses when anything still lives only in the mirror or the fingerprint
/// changed. Running lockstep and auto-sync passes re-read the posture under
/// the same lock and end; their tasks are stopped once the lock is released.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn remote_unpair_mirror(ctx: Ctx, project_id: String, expect: String) -> Result<UnpairOutcome, String> {
    let pool = ctx.get::<RemotePoolState>();
    let manifest = ctx.get::<SyncManifestState>();
    let auto = ctx.get::<AutoSyncState>();
    let reg = ctx.get::<git_peer::GitPeerRegistry>();
    if !remote::is_connected(pool, &project_id).await {
        return Err("the project is not connected; connect first".to_string());
    }
    let op = crate::services::sync_op::acquire_manual(&project_id).await?;
    let id = project_id.clone();
    let plan = app_core::rt::try_blocking("project", move || {
        let preview = preview_blocking(&id)?;
        if preview.fingerprint != expect {
            return Err(mirror_changed_refusal());
        }
        if preview.blocked() {
            return Err("the local copy still holds work the host lacks, or a tab runs on this computer; nothing was changed".to_string());
        }
        apply_unpair_blocking(&id, Path::new(&preview.mirror_path))
    })
    .await?;
    // Under the lock, like `clear_host_bound_state`: a pass that was waiting
    // finds no stale manifest in the cache to save back.
    manifest.lock().await.remove(&project_id);
    let outcome = app_core::rt::blocking("project", move || move_out_blocking(plan)).await?;
    drop(op);
    git_peer::stop(reg, &project_id).await;
    crate::services::sync_auto::stop(auto, &project_id).await;
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::git_peer::{HeadRef, RefEntry};

    fn entry(remote: Option<Value>, vm: bool) -> ProjectEntry {
        let mut v = serde_json::json!({
            "id": "p1", "name": "Proj", "status": "inactive", "local_file": "/x/project.json", "position": 0,
        });
        if let Some(remote) = remote {
            v["remote"] = remote;
        }
        if vm {
            v["vm"] = serde_json::json!({"enabled": true});
        }
        serde_json::from_value(v).expect("entry")
    }

    fn remote(extra: Value) -> Value {
        let mut v = serde_json::json!({"host": "h", "remote_path": "/srv/p"});
        v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        v
    }

    #[test]
    fn only_a_plain_remote_project_converts() {
        assert!(unpair_refusal(&entry(Some(remote(serde_json::json!({}))), false)).is_none());
        assert_eq!(unpair_refusal(&entry(None, false)).as_deref(), Some("not a remote project"));
        let vm_record = unpair_refusal(&entry(Some(remote(serde_json::json!({}))), true)).unwrap();
        assert!(vm_record.contains("VM"), "{vm_record}");
        let vm_spec = unpair_refusal(&entry(Some(remote(serde_json::json!({"vm": true}))), false)).unwrap();
        assert!(vm_spec.contains("VM"), "{vm_spec}");
        let already = unpair_refusal(&entry(Some(remote(serde_json::json!({"remote_only": true}))), false)).unwrap();
        assert!(already.starts_with(&format!("{}_REMOTE_ONLY:", crate::brand::UPPER)), "{already}");
    }

    #[test]
    fn the_reverse_refuses_every_vm() {
        assert!(keep_local_copy_refusal(&entry(Some(remote(serde_json::json!({"remote_only": true}))), false)).is_none());
        assert!(keep_local_copy_refusal(&entry(Some(remote(serde_json::json!({"vm": true}))), false)).is_some());
        assert!(keep_local_copy_refusal(&entry(Some(remote(serde_json::json!({"remote_only": true}))), true)).is_some());
        assert!(keep_local_copy_refusal(&entry(None, false)).is_some());
    }

    #[test]
    fn local_tabs_follow_the_remote_default_rule() {
        assert!(tab_runs_here("agent", None), "agents default local");
        assert!(!tab_runs_here("shell", None), "shells default to the host");
        assert!(tab_runs_here("shell", Some("local")));
        assert!(!tab_runs_here("agent", Some("remote")));
        assert!(!tab_runs_here("agent", Some("host:gpu")));
        assert!(tab_runs_here("local_agent", Some("remote")), "a local-model tab is always local");
        for kind in ["files", "projectfiles", "monitor", "browser", ""] {
            assert!(!tab_runs_here(kind, None), "{kind} runs nothing");
            assert!(!tab_runs_here(kind, Some("local")), "{kind} runs nothing");
        }
    }

    #[test]
    fn keeping_a_local_copy_pins_saved_agent_and_shell_tabs_to_the_host() {
        let tab = |kind: &str, location: Option<Value>| {
            let mut m = std::collections::HashMap::new();
            m.insert("kind".to_string(), Value::String(kind.to_string()));
            if let Some(l) = location {
                m.insert("location".to_string(), l);
            }
            m
        };
        for (kind, location) in [("agent", None), ("shell", None), ("agent", Some(Value::from("local"))), ("agent", Some(Value::from(3)))] {
            let mut t = tab(kind, location);
            assert!(pin_saved_tab_to_host(&mut t), "{kind}");
            assert_eq!(t["location"], Value::from("remote"));
        }
        for (kind, location) in [
            ("agent", Some(Value::from("remote"))),
            ("shell", Some(Value::from("host:gpu"))),
            ("files", None),
            ("monitor", Some(Value::from("local"))),
        ] {
            let mut t = tab(kind, location.clone());
            assert!(!pin_saved_tab_to_host(&mut t), "{kind} {location:?}");
            assert_eq!(t.get("location"), location.as_ref());
        }
    }

    #[test]
    fn porcelain_entries_skip_a_renames_source_field() {
        assert_eq!(porcelain_z_entries(b""), 0);
        assert_eq!(porcelain_z_entries(b" M a.txt\0?? new.txt\0"), 2);
        assert_eq!(porcelain_z_entries(b"R  new\0old\0 D gone\0"), 2);
        assert_eq!(porcelain_z_entries(b"C  copy\0src\0"), 1);
        assert_eq!(porcelain_z_entries(b"?? R\0"), 1, "a path called R is not a rename");
    }

    fn snap(branches: &[(&str, &str)], tags: &[(&str, &str)], head: Option<HeadRef>) -> PeerSnapshot {
        let refs = |v: &[(&str, &str)]| v.iter().map(|(n, s)| RefEntry { name: n.to_string(), sha: s.to_string() }).collect();
        PeerSnapshot { is_repo: true, head, branches: refs(branches), tags: refs(tags), ..Default::default() }
    }

    #[test]
    fn tips_are_branches_a_detached_head_and_tags_the_host_lacks() {
        let local = snap(
            &[("main", "a1"), ("dev", "b2"), ("copy", "a1")],
            &[("v1", "t1"), ("v2", "t2")],
            Some(HeadRef::Detached { sha: "c3".into() }),
        );
        let host = snap(&[("main", "a0")], &[("v1", "t1"), ("v2", "tX")], None);
        assert_eq!(local_tips(&local, &host), vec!["a1", "b2", "c3", "t2"]);
        let on_branch = snap(&[("main", "a1")], &[], Some(HeadRef::Branch { name: "main".into(), sha: "a1".into() }));
        assert_eq!(local_tips(&on_branch, &host), vec!["a1"]);
    }

    #[test]
    fn a_default_mirror_moves_out_and_an_explicit_one_stays() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path().join("state");
        let ssh = tmp.path().join("projects-ssh");
        let default_mirror = state.join("remote-projects").join("p1").join("mirror");
        let explicit = tmp.path().join("work").join("proj");
        let never = |_: &Path| false;
        assert_eq!(kept_destination(&explicit, &state, &ssh, "Proj", "p1", never), Some(explicit.clone()));
        assert_eq!(
            kept_destination(&default_mirror, &state, &ssh, "My Proj", "p1", never),
            Some(ssh.join(format!("{} (local copy)", sanitize_name("My Proj"))))
        );
        let leaf = sanitize_name("Proj");
        let first_two = [ssh.join(format!("{leaf} (local copy)")), ssh.join(format!("{leaf} (local copy) 2"))];
        let taken = |p: &Path| first_two.iter().any(|t| t == p);
        assert_eq!(
            kept_destination(&default_mirror, &state, &ssh, "Proj", "p1", taken),
            Some(ssh.join(format!("{leaf} (local copy) 3")))
        );
        assert_eq!(
            kept_destination(&default_mirror, &state, &ssh, "", "p1", never),
            Some(ssh.join("p1 (local copy)")),
            "a name that sanitizes away falls back to the id"
        );
        assert_eq!(kept_destination(&default_mirror, &state, &ssh, "Proj", "p1", |_| true), None);
    }

    #[test]
    fn a_move_out_keeps_git_and_never_deletes_on_failure() {
        let tmp = tempfile::tempdir().unwrap();
        let mirror = tmp.path().join("mirror");
        std::fs::create_dir_all(mirror.join(".git").join("refs")).unwrap();
        std::fs::write(mirror.join(".git").join("HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(mirror.join("notes.txt"), "mine").unwrap();
        let e = entry(Some(remote(serde_json::json!({"remote_only": true}))), false);
        let dest = tmp.path().join("out").join("proj (local copy)");
        let out = move_out_blocking(UnpairPlan { entry: e.clone(), mirror: mirror.clone(), kept_at: Some(dest.clone()) });
        assert!(out.moved && out.move_error.is_none(), "{:?}", out.move_error);
        assert_eq!(out.kept_at, dest.to_string_lossy());
        assert_eq!(std::fs::read_to_string(dest.join("notes.txt")).unwrap(), "mine");
        assert!(dest.join(".git").join("HEAD").is_file(), "git history travels with the folder");
        assert!(!mirror.exists());

        // An explicit mirror stays where it is.
        let stays = tmp.path().join("stays");
        std::fs::create_dir_all(&stays).unwrap();
        let out = move_out_blocking(UnpairPlan { entry: e.clone(), mirror: stays.clone(), kept_at: Some(stays.clone()) });
        assert!(!out.moved && out.move_error.is_none());
        assert_eq!(out.kept_at, stays.to_string_lossy());
        assert!(stays.is_dir());

        // A move that cannot happen (the destination's parent is a file)
        // leaves the folder where it was and says so.
        let blocker = tmp.path().join("blocker");
        std::fs::write(&blocker, "x").unwrap();
        let out = move_out_blocking(UnpairPlan { entry: e, mirror: stays.clone(), kept_at: Some(blocker.join("dest")) });
        assert!(!out.moved && out.move_error.is_some());
        assert_eq!(out.kept_at, stays.to_string_lossy());
        assert!(stays.is_dir(), "never deleted");
    }

    #[test]
    fn a_mirror_changed_refusal_carries_its_sentinel() {
        assert!(mirror_changed_refusal().starts_with(&format!("{}_MIRROR_CHANGED:", crate::brand::UPPER)));
    }

    #[test]
    fn the_preview_blocks_on_any_count_but_workers() {
        let clean = UnpairPreview { stopped_workers: vec!["gpu".into()], ..Default::default() };
        assert!(!clean.blocked());
        for p in [
            UnpairPreview { commits_not_on_host: 1, ..Default::default() },
            UnpairPreview { uncommitted: 1, ..Default::default() },
            UnpairPreview { unpushed_sync_edits: 1, ..Default::default() },
            UnpairPreview { local_tabs: 1, ..Default::default() },
        ] {
            assert!(p.blocked(), "{p:?}");
        }
    }

    #[test]
    fn unpushed_sync_edits_count_local_moves_and_unreadable_paths() {
        use crate::services::remote_sync::SyncEntry;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::write(root.join("same.txt"), "abc").unwrap();
        std::fs::write(root.join("edited.txt"), "abcdef").unwrap();
        let (size, mtime) = remote_sync::local_meta(&std::fs::metadata(root.join("same.txt")).unwrap());
        let base = |s: u64| SyncEntry {
            selected: true,
            local_size: s,
            local_mtime: mtime,
            last_pull_ts: Some(1),
            ..Default::default()
        };
        let mut m = remote_sync::Manifest::new();
        m.insert("same.txt".into(), base(size));
        m.insert("edited.txt".into(), base(3));
        m.insert("gone.txt".into(), base(3));
        m.insert("never.txt".into(), SyncEntry { selected: true, ..Default::default() });
        m.insert("dir".into(), SyncEntry { selected: true, is_dir: true, ..Default::default() });
        m.insert("unselected.txt".into(), SyncEntry { selected: false, local_size: 99, ..Default::default() });
        assert_eq!(unpushed_sync_edits(&m, root), 2, "edited + deleted locally");
    }
}

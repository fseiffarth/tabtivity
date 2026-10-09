//! Selective local↔remote sync commands for remote (SSH) projects.
//!
//! SSH-sync Phase 1 (`docs/ssh_sync_plan.md`). The user marks files/folders in
//! the remote file view to mirror locally; nothing syncs automatically. These
//! commands orchestrate the `services::remote_sync` core: they resolve the pooled
//! SFTP session, walk + pull the chosen subtree into the mirror, and update the
//! single-writer manifest. Pull progress is streamed as `sync-progress` events so
//! the file tree can show a spinner row (mirroring `fs_watch`'s `fs-change`).
//!
//! Every command requires the project's pooled connection to be live (the whole
//! remote surface is gated on `ssh == connected`); a cold pool errors cleanly
//! rather than opening a one-shot session, since bulk transfers must ride the
//! shared ControlMaster.

use std::collections::HashSet;
use std::sync::Arc;

use futures_util::{stream, StreamExt};
use openssh_sftp_client::Sftp;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::schema::net_usage;
use crate::services::big_folders;
use crate::services::local_loss;
use crate::services::remote::{pooled_sftp, remote_target_for, RemotePoolState, RemoteTarget};
use crate::services::remote_sync::{
    self, ensure_loaded, join_remote, local_meta, local_size_mtime, mirror_local_path, Manifest,
    PushDecision, SyncManifestState, SyncState,
};
use crate::services::sftp;

/// Max concurrent host re-stats during a `sync_status` refresh. The SFTP client
/// pipelines these over the one pooled channel; this bounds the in-flight count
/// so a large selection can't flood it.
const STAT_CONCURRENCY: usize = 16;

/// Size cutoff for content-verifying an amber verdict during a `sync_status`
/// refresh. Size+mtime is only a *heuristic* for divergence — a re-save with the
/// same bytes, or a bare `touch`, moves the mtime while the content is unchanged,
/// so the file paints amber with nothing actually to resolve. For files at or
/// below this size we confirm the amber against the actual bytes and downgrade a
/// byte-identical pair to green (re-recording the base so it *stays* green). Files
/// ABOVE this keep the pure metadata heuristic — reading them over SFTP on every
/// refresh is exactly the cost the heuristic exists to avoid.
const CONTENT_VERIFY_MAX_BYTES: u64 = 1024 * 1024; // 1 MiB

/// Cap on the NEW-local-file rows a `sync_status` pass reports. The git-derived
/// listing is naturally small (non-ignored files only), but the raw-walk
/// fallback for a non-repo mirror can surface tens of thousands of candidates —
/// and the row list is an advisory "these can be uploaded", not an inventory,
/// so a bounded IPC payload wins over completeness past this point.
const LOCAL_NEW_ROWS_CAP: usize = 2000;

/// Per-file bound on a push's SFTP round-trips. Every transfer below rides the
/// *pooled* session, and a dropped ControlMaster / dead `sftp-server` leaves a
/// request waiting on a response that never comes — an unbounded wait that hangs
/// the whole command on one file (its progress counter frozen mid-count) and, since
/// every other push leases the same session, blocks those too. 120 s clears even a
/// 64 MiB file (`MAX_SYNC_FILE_BYTES`) on a slow link with room to spare, so a
/// trip past it is a stalled connection, not a slow file.
const PUSH_FILE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// A rebase captured when an amber file proves byte-identical: the host + local
/// `(size, mtime)` to stamp as the new sync base so the file goes (and stays)
/// green instead of re-reading its bytes on every refresh.
struct ContentRebase {
    rel: String,
    host_size: u64,
    host_mtime: Option<u64>,
    local_size: u64,
    local_mtime: Option<u64>,
}

/// Confirm an amber verdict against the actual bytes, for a file small enough to
/// be worth reading. Returns `Some(rebase)` only when both sides exist, are the
/// same size, sit within [`CONTENT_VERIFY_MAX_BYTES`], and hold identical bytes —
/// i.e. the divergence was metadata-only. Returns `None` (stay amber) otherwise,
/// including on any read error: an unreadable side keeps the conservative amber.
async fn verify_amber_identical(
    sftp: &Sftp,
    host_abs: &str,
    mirror_path: &std::path::Path,
    rel: &str,
    host: (u64, Option<u64>),
    local: (u64, Option<u64>),
) -> Option<ContentRebase> {
    let (host_size, host_mtime) = host;
    let (local_size, local_mtime) = local;
    // Gate the read on the pure heuristic-vs-content policy (both sides present,
    // same size, within the cutoff — large files keep the metadata heuristic).
    if !remote_sync::content_verify_worth_it(host, local, CONTENT_VERIFY_MAX_BYTES) {
        return None;
    }
    let host_bytes = sftp::read_file_on(sftp, host_abs).await.ok()?;
    let local_bytes = std::fs::read(mirror_path).ok()?;
    (host_bytes == local_bytes).then_some(ContentRebase {
        rel: rel.to_string(),
        host_size,
        host_mtime,
        local_size,
        local_mtime,
    })
}

/// One row of sync status for the file-tree overlay.
#[derive(Debug, Clone, Serialize)]
pub struct SyncStatusEntry {
    /// Project-relative path (forward slashes).
    pub rel_path: String,
    pub is_dir: bool,
    pub selected: bool,
    /// `green` | `amber` | `none`.
    pub state: SyncState,
    /// Effective auto-sync: this path's own entry or an ancestor auto folder
    /// marker (`remote_sync::is_auto`). Drives the file-tree/viewer auto glyph.
    pub auto_sync: bool,
    /// This path's OWN byte-sync exclusion marker (not an inherited one): what
    /// the file tree flips "Exclude from sync" to "Include in sync" on, and what
    /// the giant-folder prompt shows as the standing answer. Inheritance is the
    /// transfer paths' business (`remote_sync::is_excluded`), not a row's label.
    pub excluded: bool,
    /// Current host modification time when known. This is display metadata for
    /// the diverged-files list; sync decisions still compare each side to its
    /// recorded base so host/local clock skew cannot choose an authority.
    pub host_mtime: Option<u64>,
    /// Current local-mirror modification time when known.
    pub local_mtime: Option<u64>,
    /// Host side moved from its recorded base (includes host-deleted-since-sync).
    /// Meaningful for amber rows; false for green/none.
    pub host_diverged: bool,
    /// Local mirror moved from its recorded base (includes local-deleted-since-sync).
    pub local_diverged: bool,
    /// Whether this pass actually stat'd the host for this row and got an answer.
    /// False on the unselected/dir/cold-pool branches AND when the host stat
    /// errored — a row whose host facts are last-known-good or unverified must
    /// not present them as checked (the orange list words its "gone on both
    /// sides" row differently when the host was never consulted).
    pub host_checked: bool,
}

/// Progress payload for the `sync-progress` event (one per transferred file plus
/// start/done bookends), keyed by project so the frontend can ignore other
/// projects' transfers.
#[derive(Debug, Clone, Serialize)]
struct SyncProgress {
    project_id: String,
    /// `start` | `file` | `done`.
    phase: String,
    /// The file just transferred (`phase == "file"`), else the synced root.
    rel_path: String,
    done: usize,
    total: usize,
}

/// Resolve the remote target + live pooled SFTP session for `project_id`, erroring
/// if the project is local or its connection is cold (reconnect first).
async fn resolve(
    project_id: &str,
    pool: &RemotePoolState,
) -> Result<(RemoteTarget, Arc<Sftp>), String> {
    let target = remote_target_for(project_id).ok_or_else(|| "not a remote project".to_string())?;
    // A contained mail reader has no mirror at all: "pull this to the host"
    // would be the exfiltration path with the user's click on it
    // (`services::mail_reader`). The trusted `projects.json` record decides.
    if crate::services::vm::vm_spec_for(project_id).is_some_and(|spec| spec.mail_reader) {
        return Err("this project is a mail reader and has no host-side mirror; turn \"mail reader\" off first".to_string());
    }
    let sftp = pooled_sftp(pool, project_id)
        .await
        .ok_or_else(|| "remote project not connected — reconnect first".to_string())?;
    Ok((target, sftp))
}

/// Pull a single file or a whole folder subtree from the host into the local
/// mirror, marking each pulled file selected and recording its base. `rel_path`
/// is project-relative (`""` = the whole project root). Returns how many files
/// landed and the files over the cap it left on the host
/// ([`remote_sync::PullOutcome`]). Streams `sync-progress` as it goes.
#[tauri::command]
pub async fn sync_pull(
    app: AppHandle,
    project_id: String,
    rel_path: String,
    pool: State<'_, RemotePoolState>,
    manifest: State<'_, SyncManifestState>,
) -> Result<remote_sync::PullOutcome, String> {
    let (target, sftp) = resolve(&project_id, pool.inner()).await?;
    pull_subtree(
        &app,
        &project_id,
        &target,
        &sftp,
        &rel_path,
        manifest.inner(),
    )
    .await
}

/// Pull the entire project tree into the mirror (the one-click "sync whole
/// project"). Equivalent to `sync_pull` with an empty `rel_path`.
#[tauri::command]
pub async fn sync_whole_project(
    app: AppHandle,
    project_id: String,
    pool: State<'_, RemotePoolState>,
    manifest: State<'_, SyncManifestState>,
) -> Result<remote_sync::PullOutcome, String> {
    let (target, sftp) = resolve(&project_id, pool.inner()).await?;
    pull_subtree(&app, &project_id, &target, &sftp, "", manifest.inner()).await
}

/// Toggle the `selected` flag for one or more project-relative paths WITHOUT
/// transferring anything (e.g. deselecting to stop tracking). Selecting a path
/// the user then wants mirrored is followed by `sync_pull`; selecting alone just
/// records intent. Mirror bytes are left in place on deselect.
#[tauri::command]
pub async fn sync_mark_selected(
    project_id: String,
    rel_paths: Vec<String>,
    selected: bool,
    is_dir: bool,
    manifest: State<'_, SyncManifestState>,
) -> Result<(), String> {
    let mut guard = manifest.lock().await;
    let m = ensure_loaded(&mut guard, &project_id);
    for rel in &rel_paths {
        let entry = m.entry(rel.clone()).or_default();
        entry.selected = selected;
        if is_dir {
            entry.is_dir = true;
        }
    }
    remote_sync::save_manifest(&project_id, m)
}

/// Toggle auto-sync for one or more project-relative paths. Turning it ON sets
/// `auto_sync` (and implies `selected = true`, clearing any exclusion). On a
/// directory the marker covers the whole subtree (resolved by
/// `remote_sync::is_auto`); the empty path `""` is the project-wide "auto-sync
/// all" root marker. Turning it OFF records an explicit `auto_off` EXCLUSION
/// (clearing `auto_sync`) so a path can be carved out of an ancestor's — or the
/// project-wide — auto-sync; `selected` is left as-is (manual tracking continues),
/// matching the deselect-leaves-bytes convention. No bytes transfer here — the
/// background reconcile engine (`services::sync_auto`) acts on its next pass.
#[tauri::command]
pub async fn sync_set_auto(
    project_id: String,
    rel_paths: Vec<String>,
    auto: bool,
    is_dir: bool,
    manifest: State<'_, SyncManifestState>,
) -> Result<(), String> {
    let mut guard = manifest.lock().await;
    let m = ensure_loaded(&mut guard, &project_id);
    for rel in &rel_paths {
        apply_auto_marker(m.entry(rel.clone()).or_default(), auto, is_dir);
    }
    remote_sync::save_manifest(&project_id, m)
}

/// The marker write behind [`sync_set_auto`], on one entry. OFF records an explicit
/// `auto_off` (overrides an ancestor/project-wide auto); ON marks the path tracked
/// and clears **both** carve-outs — `auto_off` and `excluded`. The exclusion has to
/// go too: `is_auto` and `is_excluded` both consult a path's own `excluded` before
/// its `auto_sync`, so an entry carrying both was still excluded, and turning auto
/// on for a folder the giant-folder prompt had excluded was a silent no-op — the
/// glyph flipped, the engine kept skipping. Pure, unit-tested.
fn apply_auto_marker(entry: &mut remote_sync::SyncEntry, auto: bool, is_dir: bool) {
    entry.auto_sync = auto;
    entry.auto_off = !auto;
    if auto {
        entry.selected = true;
        entry.excluded = false;
    }
    if is_dir {
        entry.is_dir = true;
    }
}

/// What turning auto-sync ON over a host subtree would start pulling.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoSyncPreview {
    pub files: usize,
    pub bytes: u64,
}

/// Cost preview for `sync_set_auto(auto = true)` on a directory. Read-only.
///
/// Byte-sync's scope is an explicit opt-in manifest and it does **not** read
/// `.gitignore` — the two systems have different notions of what is in scope. So
/// marking a host folder auto is the one click that can start hauling a tree the
/// user deliberately keeps host-side (experiment output, checkpoints: gitignored,
/// therefore also invisible to lockstep) into the local mirror. The frontend calls
/// this first and confirms when the answer is large, so the pull is a decision
/// rather than a surprise.
///
/// Walks the **host** because that is the side that holds the bytes in the case
/// worth warning about; a `rel` that is a file (not a directory) fails the walk
/// and reports a single entry, which is never large enough to warn on anyway.
#[tauri::command]
pub async fn sync_auto_preview(
    project_id: String,
    rel_path: String,
    pool: State<'_, RemotePoolState>,
) -> Result<AutoSyncPreview, String> {
    let (target, sftp) = resolve(&project_id, pool.inner()).await?;
    let files = remote_sync::walk_host_files(&sftp, &target.spec.remote_path, &rel_path).await?;
    Ok(AutoSyncPreview {
        files: files.len(),
        bytes: files.iter().map(|f| f.size).sum(),
    })
}

/// One folder big enough to be worth a question before the first sync pass, with
/// what each side holds. A folder that exists on only one side reports zeros for
/// the other — which is itself the answer to "is this the host's data or mine?".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BigFolderRow {
    pub rel: String,
    pub local_files: u64,
    pub local_bytes: u64,
    pub host_files: u64,
    pub host_bytes: u64,
    /// Already carrying an explicit exclusion marker (so re-opening the prompt
    /// shows the standing answer rather than asking again from scratch).
    pub excluded: bool,
}

/// The whole giant-folder answer, plus which sides it could actually measure.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BigFolderScan {
    pub folders: Vec<BigFolderRow>,
    /// The host tree was walked (i.e. the pool was live). When false the rows
    /// carry local numbers only — the caller re-runs once the project connects.
    pub host_scanned: bool,
    /// Why the host side is missing, when it is and the reason isn't "cold pool".
    pub host_error: Option<String>,
}

/// Find the folders too big to sync silently — on **both** sides.
///
/// This is the question `sync_auto_preview` asks one folder at a time, asked for
/// the whole project at the moment it matters: a project just created, imported,
/// or extended to a host, before anything has been hauled anywhere. Byte-sync
/// does not read `.gitignore`, so nothing else in the system would ever mention
/// that `node_modules/`, `data/` or `checkpoints/` is about to cross.
///
/// Read-only. The local mirror is walked directly; the host side is one `du -ak`
/// round trip over the pooled ControlMaster, and is **skipped** (not attempted)
/// when the pool is cold — dispatching at a dead session is what freezes the
/// window, and a disconnected project's answer is simply "local only, ask again
/// once connected".
///
/// `scan_host` (default **true**, so an ordinary host behaves exactly as before)
/// is what a **careful** host turns off. `du -ak -x` stats every file under the
/// project root, and on a cluster that root is very often on the *parallel*
/// filesystem — because that is precisely where the HPC workspace feature puts
/// it. A recursive stat of a whole tree is a metadata storm against a shared
/// Lustre/GPFS metadata server, which is the kind of thing a site's usage policy
/// actually names. That it is also *cheap for us* and *automatic on connect* is
/// what makes it worth gating: the caller decides, and a careful host's census
/// runs local-only until the user asks for the host half by name.
///
/// The host half is skipped, never faked: `hostScanned` stays false, which the
/// dialog already renders as "—" per row rather than as a zero.
///
/// `confirmed` is the tagged-host escape hatch (G.24). The `du` half used to be
/// refused **unconditionally** on a machine tagged HPC, which was right for the
/// automatic census — it fires on connect, so nobody asked for that particular
/// walk of a parallel filesystem — and wrong for the other caller: the file
/// view's "Large folders…" is a person naming this machine and asking for the
/// numbers. With no flag to carry that distinction the explicit ask could only
/// ever be refused, so the frontend was reduced to *saying* the census would be
/// local-only. It now refuses with `hpc_mode`'s `HPC_GUARD` sentinel instead —
/// the shape `disk_usage_scan` already uses — which `lib/remote/hpc/hpcGuard`'s
/// `withHpcConfirm` turns into a dialog naming the machine and one retry with
/// `confirmed: true`. Per run, never remembered, exactly as the other gate.
#[tauri::command]
pub async fn sync_big_folders(
    project_id: String,
    scan_host: Option<bool>,
    confirmed: Option<bool>,
    pool: State<'_, RemotePoolState>,
    manifest: State<'_, SyncManifestState>,
) -> Result<BigFolderScan, String> {
    let target =
        remote_target_for(&project_id).ok_or_else(|| "not a remote project".to_string())?;

    // The refusal comes BEFORE any work, so the retry the dialog offers repeats
    // nothing: a refused call did not walk the mirror either.
    //
    // Only a caller that actually wants the host half can trip it — asking for a
    // local-only census of a tagged project is not the act the tag guards, and
    // making it prompt would put a dialog in front of the automatic on-connect
    // census, which is the exact thing the tag exists to keep quiet.
    let wants_host = scan_host.unwrap_or(true);
    let tagged = crate::services::hpc_mode::is_hpc_spec(&target.spec);
    if wants_host && tagged && confirmed != Some(true) {
        return Err(crate::services::hpc_mode::guard_error(
            "du-scan",
            &target.spec,
        ));
    }

    // Local mirror walk (blocking fs work — off the UI thread).
    let mirror = remote_sync::mirror_dir(&project_id);
    let local = tokio::task::spawn_blocking(move || big_folders::scan_local(&mirror))
        .await
        .map_err(|e| e.to_string())?;

    // A confirmed census is the user asking for this machine by name, so it also
    // clears the dial policy that would otherwise refuse the `du`'s own ssh one
    // layer down — one confirmation covers the whole act (`disk_usage_scan`'s
    // rule, applied here for the same reason).
    let _dial = (confirmed == Some(true)).then(|| {
        crate::services::ssh_common::user_dial(
            &target.spec.user,
            &target.spec.host,
            target.spec.port,
        )
    });

    // Host walk, only when asked for AND with a live pool behind it. The pool
    // check is skipped entirely when the caller doesn't want the host half, so a
    // careful host is never even dialled for it.
    let scan_host = wants_host;
    let connected = scan_host && pooled_sftp(pool.inner(), &project_id).await.is_some();
    let mut host_error = None;
    let host = if connected {
        let spec = target.spec.clone();
        let root = spec.remote_path.clone();
        match tokio::task::spawn_blocking(move || {
            crate::services::ssh_exec::remote_du_raw(&spec, &root)
        })
        .await
        .map_err(|e| e.to_string())?
        {
            Ok(out) => big_folders::scan_host(&target.spec.remote_path, &out),
            Err(e) => {
                host_error = Some(e);
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };

    // Merge by path: one row per folder, whichever side(s) reported it.
    let mut rows: std::collections::BTreeMap<String, BigFolderRow> = Default::default();
    for f in local {
        let row = rows.entry(f.rel.clone()).or_insert(BigFolderRow {
            rel: f.rel.clone(),
            local_files: 0,
            local_bytes: 0,
            host_files: 0,
            host_bytes: 0,
            excluded: false,
        });
        row.local_files = f.files;
        row.local_bytes = f.bytes;
    }
    for f in host {
        let row = rows.entry(f.rel.clone()).or_insert(BigFolderRow {
            rel: f.rel.clone(),
            local_files: 0,
            local_bytes: 0,
            host_files: 0,
            host_bytes: 0,
            excluded: false,
        });
        row.host_files = f.files;
        row.host_bytes = f.bytes;
    }

    let mut folders: Vec<BigFolderRow> = {
        let mut guard = manifest.lock().await;
        let m = ensure_loaded(&mut guard, &project_id);
        rows.into_values()
            .map(|mut r| {
                r.excluded = m.get(&r.rel).map(|e| e.excluded).unwrap_or(false);
                r
            })
            .collect()
    };
    folders.sort_by_key(|f| std::cmp::Reverse(f.host_bytes.max(f.local_bytes)));

    Ok(BigFolderScan {
        folders,
        host_scanned: connected,
        host_error,
    })
}

/// Record (or lift) an explicit byte-sync **exclusion** for one or more folders —
/// the answer the giant-folder prompt collects.
///
/// Stronger than `sync_set_auto(false)`, which only carves a path out of the
/// background engine: an exclusion is also honoured by the one-click whole-project
/// pull and push (`pull_subtree` / `sync_push`), which is the transfer the prompt
/// exists to keep off a multi-GB tree. Nothing is deleted either way — mirror bytes
/// already present stay exactly where they are.
#[tauri::command]
pub async fn sync_set_excluded(
    project_id: String,
    rel_paths: Vec<String>,
    excluded: bool,
    manifest: State<'_, SyncManifestState>,
) -> Result<(), String> {
    let mut guard = manifest.lock().await;
    let m = ensure_loaded(&mut guard, &project_id);
    for rel in &rel_paths {
        let entry = m.entry(rel.clone()).or_default();
        entry.excluded = excluded;
        entry.is_dir = true;
        if excluded {
            // An excluded folder is not auto-synced, whatever an ancestor (or the
            // project-wide root marker) says — otherwise the background engine
            // would keep hauling what the pull path now skips.
            entry.auto_sync = false;
            entry.auto_off = true;
        }
    }
    remote_sync::save_manifest(&project_id, m)
}

/// Return the sync status of every tracked path, re-stat'ing each selected FILE
/// on the host so the green/amber state is fresh (amber = host moved since the
/// last fetch). Directories report their stored selection (no re-stat). This is
/// the explicit "refresh" the plan calls out — there is no live watcher.
#[tauri::command]
pub async fn sync_status(
    project_id: String,
    pool: State<'_, RemotePoolState>,
    manifest: State<'_, SyncManifestState>,
) -> Result<Vec<SyncStatusEntry>, String> {
    // A local project has no sync; return empty rather than erroring (callers may
    // probe indiscriminately).
    let Some(target) = remote_target_for(&project_id) else {
        return Ok(Vec::new());
    };
    // Snapshot the whole manifest under the lock; re-stat outside it. The full
    // snapshot (not just the (k,v) list) lets `is_auto` walk ancestor folder
    // markers to resolve each row's effective auto-sync flag.
    let snapshot: Manifest = {
        let mut guard = manifest.lock().await;
        ensure_loaded(&mut guard, &project_id).clone()
    };
    let entries: Vec<(String, crate::services::remote_sync::SyncEntry)> = snapshot
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    // Re-stat selected files when the pool is live; if cold, fall back to the
    // stored base (green for selected) rather than erroring out the whole panel.
    let sftp = pooled_sftp(pool.inner(), &project_id).await;
    // With lockstep on, the git-tracked tree is lockstep's (#28p D1): those files
    // travel as commits, byte-sync never touches them, and their manifest bases
    // (seeded at pairing, re-stamped after a checkout) go stale the moment a
    // fast-forward rewrites the *other* side. Stat'ing them here painted every
    // file a commit changed amber/orange until the content check happened to
    // heal it — and never healed one over the content-verify cutoff, leaving
    // orange rows whose pull/push buttons could not act (`drop_lockstep_tracked`
    // withholds them). Resolve the set once, off the async thread (git spawns).
    let lockstep_tracked: HashSet<String> = {
        let pid = project_id.clone();
        tokio::task::spawn_blocking(move || {
            if crate::services::git_peer::load_state(&pid).enabled {
                crate::services::git_peer::tracked_paths(&pid)
            } else {
                HashSet::new()
            }
        })
        .await
        .unwrap_or_default()
    };
    let mut out = Vec::with_capacity(entries.len());
    // Partition without any network first: only selected FILES against a live
    // pool need a host re-stat. Everything else (unselected → none, directories →
    // green, cold pool → last-known-good green) resolves immediately.
    let mut to_stat: Vec<(String, crate::services::remote_sync::SyncEntry, bool, bool)> =
        Vec::new();
    for (rel, entry) in entries {
        // Effective auto-sync and exclusion both resolve against the whole manifest
        // (ancestor folder markers), so compute them before `rel` is moved into the
        // row. A file excluded only via an ancestor folder marker (no marker of its
        // own) must still drop out of the diverged (amber) view — `entry.excluded`
        // alone (the row's OWN marker, see `SyncStatusEntry::excluded`) would miss
        // that case.
        let auto = remote_sync::is_auto(&snapshot, &rel);
        let excluded_eff = remote_sync::is_excluded(&snapshot, &rel, "");
        if !entry.selected {
            out.push(SyncStatusEntry {
                rel_path: rel,
                is_dir: entry.is_dir,
                selected: false,
                state: SyncState::None,
                auto_sync: false, // auto implies selected, so unselected is never auto
                excluded: entry.excluded,
                host_mtime: None,
                local_mtime: None,
                host_diverged: false,
                local_diverged: false,
                host_checked: false,
            });
        } else if entry.is_dir {
            out.push(SyncStatusEntry {
                rel_path: rel,
                is_dir: true,
                selected: true,
                state: SyncState::Green,
                auto_sync: auto,
                excluded: entry.excluded,
                host_mtime: None,
                local_mtime: None,
                host_diverged: false,
                local_diverged: false,
                host_checked: false,
            });
        } else if lockstep_tracked.contains(&rel) {
            // Lockstep-owned: in step as of the last commit on either side, kept so
            // by `git_peer`, and reported green exactly as the pairing seed meant it
            // to read. Not stat'd — the host was not consulted for this row, and an
            // uncommitted local edit is git's `M` marker, not a byte-sync divergence.
            out.push(SyncStatusEntry {
                rel_path: rel,
                is_dir: false,
                selected: true,
                state: SyncState::Green,
                auto_sync: auto,
                excluded: entry.excluded,
                host_mtime: None,
                local_mtime: None,
                host_diverged: false,
                local_diverged: false,
                host_checked: false,
            });
        } else if sftp.is_some() {
            to_stat.push((rel, entry, auto, excluded_eff));
        } else {
            // Cold pool: the host can't be re-stat'd, but the local mirror still
            // can (no network) — so a local-only edit made while disconnected
            // still surfaces as amber instead of a stale green.
            let local = std::fs::metadata(mirror_local_path(&project_id, &rel))
                .ok()
                .map(|m| local_meta(&m));
            let state = remote_sync::compute_state(&entry, None, local, excluded_eff);
            // Host side is never flagged on a cold pool (nothing was checked).
            let (hd, ld) = remote_sync::divergence(&entry, None, local);
            let excluded_row = state == SyncState::None;
            out.push(SyncStatusEntry {
                rel_path: rel,
                is_dir: false,
                selected: true,
                state,
                auto_sync: auto,
                excluded: entry.excluded,
                host_mtime: None,
                local_mtime: local.and_then(|(_, mtime)| mtime),
                host_diverged: if excluded_row { false } else { hd },
                local_diverged: if excluded_row { false } else { ld },
                host_checked: false,
            });
        }
    }
    // Re-stat the selected files concurrently over the pooled SFTP session. The
    // client multiplexes many in-flight requests over the one channel, so a large
    // selection is latency-bound (~one round-trip worth) instead of N sequential
    // round-trips. `buffer_unordered` caps the in-flight count so a huge selection
    // can't flood the channel; order is irrelevant (the frontend keys status by
    // `rel_path`). The stat/compare rule itself is unchanged.
    if let Some(sftp) = &sftp {
        let statted = stream::iter(to_stat.into_iter().map(|(rel, entry, auto, excluded_eff)| {
            let sftp = Arc::clone(sftp);
            let root = target.spec.remote_path.clone();
            let project_id = project_id.clone();
            async move {
                let host_abs = join_remote(&root, &rel);
                // Tri-state host stat: Ok(Some) = present, Ok(None) = the server's
                // NoSuchFile (positively gone), Err = could not check (dropped
                // session, permission, timeout). Only Ok(None) may feed the prune —
                // an Err collapsed into "gone" would let one dropped session mid-
                // refresh prune the entire manifest in a single save.
                let host_stat = sftp::metadata_opt_on(&sftp, &host_abs).await;
                // CRITICAL INVARIANT: `divergence(entry, None, …)` means "couldn't
                // check → don't flag", so passing the real Option through would flip
                // host-deleted files from amber to green. The (0, None) fallback is
                // therefore kept for state/divergence computation — it preserves
                // today's one-side-deleted amber EXACTLY; the tri-state is used
                // ONLY for both-gone detection (the prune below).
                let (size, mtime) = host_stat
                    .as_ref()
                    .ok()
                    .copied()
                    .flatten()
                    .unwrap_or((0, None));
                let host_for_compute = Some((size, mtime));
                let mirror_path = mirror_local_path(&project_id, &rel);
                // Same tri-state for the local mirror: only io NotFound is
                // "gone"; any other error (permissions, an I/O fault) must not
                // license a prune.
                let local_stat: Result<Option<(u64, Option<u64>)>, String> =
                    match std::fs::metadata(&mirror_path) {
                        Ok(m) => Ok(Some(local_meta(&m))),
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                        Err(e) => Err(e.to_string()),
                    };
                // For state/divergence, keep today's semantics exactly: any
                // unreadable mirror file (gone OR erroring) reads as absent.
                let local = local_stat.as_ref().ok().copied().flatten();
                if remote_sync::should_prune(&entry, &host_stat, &local_stat) {
                    // Positively gone on both sides after a sync: nothing to
                    // compare, resolve, or protect — drop the manifest entry
                    // instead of emitting a row. The snapshot `entry` rides along
                    // so the removal can be guarded against a concurrent rewrite.
                    return (None, None, Some((rel, entry)));
                }
                let mut state =
                    remote_sync::compute_state(&entry, host_for_compute, local, excluded_eff);
                let (mut hd, mut ld) = remote_sync::divergence(&entry, host_for_compute, local);
                // The divergence fields are documented "false for green/none": an
                // excluded row computes state None here, so force them clean like
                // the cold-pool branch does.
                if state == SyncState::None {
                    hd = false;
                    ld = false;
                }
                // A metadata-only amber (same bytes, drifted mtime/size-vs-base) is a
                // false positive: for a small file, confirm against the actual bytes
                // and downgrade an identical pair to green, capturing the rebase so it
                // is re-recorded and stays green. Large files keep the heuristic.
                let mut rebase = None;
                if state == SyncState::Amber {
                    if let Some(local_vals) = local {
                        if let Some(rb) = verify_amber_identical(
                            &sftp,
                            &host_abs,
                            &mirror_path,
                            &rel,
                            (size, mtime),
                            local_vals,
                        )
                        .await
                        {
                            state = SyncState::Green;
                            hd = false;
                            ld = false;
                            rebase = Some(rb);
                        }
                    }
                }
                (
                    Some(SyncStatusEntry {
                        rel_path: rel,
                        is_dir: false,
                        selected: true,
                        state,
                        auto_sync: auto,
                        excluded: entry.excluded,
                        host_mtime: mtime,
                        local_mtime: local.and_then(|(_, mtime)| mtime),
                        host_diverged: hd,
                        local_diverged: ld,
                        // An errored stat is not a check: only a host answer
                        // (present or NoSuchFile) counts as "checked".
                        host_checked: host_stat.is_ok(),
                    }),
                    rebase,
                    None,
                )
            }
        }))
        .buffer_unordered(STAT_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
        // Split the rows from the content-verified rebases and the both-gone
        // prunes: the rows go straight to the response, the rebases + prunes are
        // applied to the manifest under the single-writer lock and persisted once
        // (only when at least one file self-healed or vanished on both sides).
        let mut rebases = Vec::new();
        let mut prunes: Vec<(String, crate::services::remote_sync::SyncEntry)> = Vec::new();
        for (row, rb, prune) in statted {
            if let Some(rb) = rb {
                rebases.push(rb);
            }
            if let Some(p) = prune {
                prunes.push(p);
            }
            if let Some(row) = row {
                out.push(row);
            }
        }
        if !rebases.is_empty() || !prunes.is_empty() {
            let mut guard = manifest.lock().await;
            let m = ensure_loaded(&mut guard, &project_id);
            for rb in &rebases {
                remote_sync::record_pull(
                    m,
                    &rb.rel,
                    rb.host_size,
                    rb.host_mtime,
                    rb.local_size,
                    rb.local_mtime,
                );
            }
            for (rel, snapshot) in &prunes {
                // Remove only if the entry is still exactly what was stat'd: a
                // concurrent record_pull/record_push between the stat and this
                // lock means the file is alive again — its fresh base must win.
                if m.get(rel) == Some(snapshot) {
                    m.remove(rel);
                }
            }
            let _ = remote_sync::save_manifest(&project_id, m);
        }
    }
    // NEW-local-file pass: files the mirror holds that the manifest has never
    // seen. Everything above iterates the manifest, so without this a file
    // created after the last transfer had NO row anywhere — no tree badge, no
    // diverged-list entry, nothing saying "exists only locally, can be
    // uploaded". Purely local work (git + fs), so it runs on a cold pool too.
    // For a git-backed mirror the listing is `ls-files -co --exclude-standard`:
    // .gitignore is the honest noise filter there (caches/venvs/results are
    // exactly what the user chose not to version, and a raw walk would report
    // them as thousands of "new" files). A non-repo mirror falls back to the
    // raw walk; either way the pure filter drops manifest'd, lockstep-owned
    // (tracked, when lockstep is on) and excluded paths, and caps the rest.
    {
        let pid = project_id.clone();
        let snapshot_for_new = snapshot.clone();
        let new_rows = tokio::task::spawn_blocking(move || {
            let all: Vec<String> = match crate::services::git_peer::non_ignored_paths(&pid) {
                Some(set) => set.into_iter().collect(),
                None => remote_sync::walk_mirror_files(&pid, "").unwrap_or_default(),
            };
            let tracked = crate::services::git_peer::tracked_paths(&pid);
            let lockstep = crate::services::git_peer::load_state(&pid).enabled;
            let candidates = remote_sync::local_new_candidates(
                &snapshot_for_new,
                all,
                &tracked,
                lockstep,
                LOCAL_NEW_ROWS_CAP,
            );
            candidates
                .into_iter()
                .filter_map(|rel| {
                    // Stat for the row's mtime; a file that vanished between the
                    // listing and here is simply not new any more.
                    let meta = std::fs::metadata(mirror_local_path(&pid, &rel)).ok()?;
                    let (_, mtime) = local_meta(&meta);
                    let auto = remote_sync::is_auto(&snapshot_for_new, &rel);
                    Some(SyncStatusEntry {
                        rel_path: rel,
                        is_dir: false,
                        selected: false,
                        state: SyncState::LocalNew,
                        auto_sync: auto,
                        excluded: false,
                        host_mtime: None,
                        local_mtime: mtime,
                        // The mirror side is what makes the row exist; the host
                        // was never asked (there is nothing to ask about).
                        host_diverged: false,
                        local_diverged: true,
                        host_checked: false,
                    })
                })
                .collect::<Vec<_>>()
        })
        .await
        .unwrap_or_default();
        out.extend(new_rows);
    }
    Ok(out)
}

/// One side (local mirror OR host) of a tracked file, for the amber "resolve"
/// popup. `exists` is false when that side has no such file (deleted/never
/// created); `size`/`mtime` are then zero/None.
#[derive(Debug, Clone, Serialize)]
pub struct SideMeta {
    pub exists: bool,
    pub size: u64,
    /// Unix seconds, when the side reports one.
    pub mtime: Option<u64>,
}

/// Local + host metadata for one tracked file, plus the recorded base — backs
/// the amber divergence popup (size/mtime on each side so the user can see what
/// changed before choosing "take local" or "take remote").
#[derive(Debug, Clone, Serialize)]
pub struct SyncFileMeta {
    pub rel_path: String,
    pub local: SideMeta,
    pub host: SideMeta,
    /// Host base (size + mtime) captured at the last pull/push — what the
    /// green/amber state is judged against.
    pub base_size: u64,
    pub base_mtime: Option<u64>,
}

/// Return the local-mirror and current-host metadata for one file so the amber
/// popup can show the concrete divergence (size + mtime, per side) alongside the
/// recorded base. Requires a live pooled connection to stat the host; a cold
/// pool errors via `resolve` (the popup only opens for a connected project).
#[tauri::command]
pub async fn sync_file_meta(
    project_id: String,
    rel_path: String,
    pool: State<'_, RemotePoolState>,
    manifest: State<'_, SyncManifestState>,
) -> Result<SyncFileMeta, String> {
    let (target, sftp) = resolve(&project_id, pool.inner()).await?;
    let host_abs = join_remote(&target.spec.remote_path, &rel_path);
    let host = match sftp::metadata_on(&sftp, &host_abs).await {
        Ok((size, mtime)) => SideMeta {
            exists: true,
            size,
            mtime,
        },
        Err(_) => SideMeta {
            exists: false,
            size: 0,
            mtime: None,
        },
    };
    let local_path = mirror_local_path(&project_id, &rel_path);
    let local = match std::fs::metadata(&local_path) {
        Ok(m) => {
            let (size, mtime) = local_size_mtime(Some(m));
            SideMeta {
                exists: true,
                size,
                mtime,
            }
        }
        Err(_) => SideMeta {
            exists: false,
            size: 0,
            mtime: None,
        },
    };
    let (base_size, base_mtime) = {
        let mut guard = manifest.lock().await;
        let m = ensure_loaded(&mut guard, &project_id);
        m.get(&rel_path)
            .map(|e| (e.host_size, e.host_mtime))
            .unwrap_or((0, None))
    };
    Ok(SyncFileMeta {
        rel_path,
        local,
        host,
        base_size,
        base_mtime,
    })
}

/// Byte-for-byte check for one diverged (amber) file, run when the three-way
/// merge viewer opens it. If the local mirror and the current host copy hold
/// **identical bytes**, the divergence was metadata-only (a re-save with the same
/// content, a bare `touch`, or a stale base): re-record the sync base from both
/// sides' fresh `(size, mtime)` so the file clears amber → green — no transfer,
/// since the bytes already match — and return `true`. Returns `false` when the
/// sides genuinely differ, or when either side is missing/unreadable (a real
/// divergence the viewer must resolve). Requires a live pooled connection to read
/// the host over SFTP; a cold pool errors via `resolve`.
///
/// This is the same "amber is size+mtime, not content" self-heal that
/// [`verify_amber_identical`] applies during a `sync_status` refresh, but WITHOUT
/// that path's size cutoff: the user explicitly opened the viewer for this one
/// file, so reading it once — however large — is a decision, not the per-refresh
/// cost the heuristic exists to avoid.
#[tauri::command]
pub async fn sync_resolve_if_identical(
    project_id: String,
    rel_path: String,
    pool: State<'_, RemotePoolState>,
    manifest: State<'_, SyncManifestState>,
) -> Result<bool, String> {
    let (target, sftp) = resolve(&project_id, pool.inner()).await?;
    let host_abs = join_remote(&target.spec.remote_path, &rel_path);
    // Read both sides fully. A side that can't be read (deleted on the host, never
    // pulled locally) is not "identical" — leave it amber for the merge viewer.
    let Ok(host_bytes) = sftp::read_file_on(&sftp, &host_abs).await else {
        return Ok(false);
    };
    let mirror_path = mirror_local_path(&project_id, &rel_path);
    let Ok(local_bytes) = std::fs::read(&mirror_path) else {
        return Ok(false);
    };
    if host_bytes != local_bytes {
        return Ok(false);
    }
    // Identical: stamp a fresh base from each side's current metadata so the file
    // goes (and stays) green without any byte transfer.
    let (host_size, host_mtime) = sftp::metadata_on(&sftp, &host_abs)
        .await
        .unwrap_or((host_bytes.len() as u64, None));
    let (ls, lm) = local_size_mtime(std::fs::metadata(&mirror_path).ok());
    let mut guard = manifest.lock().await;
    let m = ensure_loaded(&mut guard, &project_id);
    remote_sync::record_pull(m, &rel_path, host_size, host_mtime, ls, lm);
    remote_sync::save_manifest(&project_id, m)?;
    Ok(true)
}

/// Propagate a one-sided deletion of a tracked file to the other side, so the
/// diverged (orange) list can finish a deletion instead of only undoing it.
///
/// A file deleted on exactly one side sits amber with only one live action: pull
/// (restore the mirror from the host) or push (restore the host from the mirror).
/// Both *undo* the deletion; nothing could *complete* it, so a file deleted
/// locally kept resurrecting from the host however often it was deleted. This is
/// the missing half: `side` names which copy dies — `"host"` applies a local
/// deletion to the host, `"local"` accepts a host deletion into the mirror.
///
/// Two verifications gate the delete, both against the live state rather than the
/// cached status the button was drawn from (the click can be minutes stale):
/// - the side the deletion supposedly happened on must be **positively absent** —
///   for the host that means the SFTP `NoSuchFile` answer, never a stat error
///   (the same tri-state rule the both-gone prune lives by); a file that is
///   actually still there means the premise is wrong and the command refuses;
/// - a surviving copy that is *already* gone is not an error: both sides absent
///   is the both-gone state, so the entry is pruned and the command succeeds
///   without deleting anything.
///
/// Deleting the mirror copy is recorded in the local-loss log (`LossKind::Deleted`)
/// — it is user-confirmed, but the log is the record of every destructive local
/// write and an explicit one is still one. The manifest entry is removed under the
/// same snapshot guard the status prune uses, so a concurrent pull that revived
/// the file keeps its fresh base.
#[tauri::command]
pub async fn sync_apply_delete(
    project_id: String,
    rel_path: String,
    side: String,
    pool: State<'_, RemotePoolState>,
    manifest: State<'_, SyncManifestState>,
) -> Result<(), String> {
    if rel_path.is_empty() {
        return Err("a deletion names one file, never the project root".to_string());
    }
    if side != "host" && side != "local" {
        return Err(format!("unknown delete side: {side}"));
    }
    let (target, sftp) = resolve(&project_id, pool.inner()).await?;
    let host_abs = join_remote(&target.spec.remote_path, &rel_path);
    let mirror_path = mirror_local_path(&project_id, &rel_path);
    // Snapshot the entry now: the removal below is guarded on it being unchanged,
    // exactly like the status pass's both-gone prune.
    let snapshot = {
        let mut guard = manifest.lock().await;
        let m = ensure_loaded(&mut guard, &project_id);
        let entry = m.get(&rel_path).cloned();
        if entry.as_ref().is_some_and(|e| e.is_dir) {
            return Err("a directory marker has no copy to delete".to_string());
        }
        entry
    };
    // Tri-state host stat: present / positively gone / could not check.
    let host_stat = sftp::metadata_opt_on(&sftp, &host_abs).await;
    let local_exists = match std::fs::metadata(&mirror_path) {
        Ok(_) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => return Err(format!("could not check the local mirror copy: {e}")),
    };
    if side == "host" {
        // Premise: the file was deleted locally. Refuse if the mirror copy is in
        // fact still there — this action must never become a way to delete a host
        // file that has a live local twin.
        if local_exists {
            return Err(
                "the local mirror still holds this file — this action only propagates a local deletion".to_string(),
            );
        }
        match host_stat {
            Ok(Some(_)) => sftp::remove_file_on(&sftp, &host_abs).await?,
            Ok(None) => {} // already gone on both sides — just prune below
            Err(e) => return Err(format!("could not check the host copy: {e}")),
        }
    } else {
        // Premise: the file was deleted on the host. Only the positive NoSuchFile
        // answer licenses deleting the mirror copy — an errored stat must not.
        match host_stat {
            Ok(None) => {}
            Ok(Some(_)) => {
                return Err(
                    "the host still holds this file — this action only accepts a host deletion"
                        .to_string(),
                )
            }
            Err(e) => return Err(format!("could not confirm the host copy is gone: {e}")),
        }
        if local_exists {
            // #863: never unlink through a symlinked directory out of the mirror.
            remote_sync::confined_mirror_path(&remote_sync::mirror_dir(&project_id), &rel_path)?;
            std::fs::remove_file(&mirror_path)
                .map_err(|e| format!("delete local mirror copy failed: {e}"))?;
            // The mirror copy was the file's last copy anywhere; the confirm dialog
            // said so, and the local-loss log keeps the record. Recorded AFTER the
            // delete (unlike `warn_overwritten`, whose evidence the write destroys):
            // a failed delete must not log a loss that never happened.
            local_loss::record_paths(
                &project_id,
                local_loss::LossSource::Sync,
                local_loss::LossKind::Deleted,
                "Accepted a host-side deletion (diverged-files list)",
                vec![rel_path.clone()],
                None,
            );
        }
    }
    // Both sides are gone now: drop the manifest entry so the row leaves the
    // orange list — guarded against a concurrent rewrite reviving the file.
    if let Some(snapshot) = snapshot {
        let mut guard = manifest.lock().await;
        let m = ensure_loaded(&mut guard, &project_id);
        if m.get(&rel_path) == Some(&snapshot) {
            m.remove(&rel_path);
            let _ = remote_sync::save_manifest(&project_id, m);
        }
    }
    Ok(())
}

/// Cap on the per-file host stats a **push** preview will pay for. A push preview
/// re-stats every file it would write, which is the same round-trip count the push
/// itself pays — fine for a folder, wasteful for a whole tree. Past this count the
/// preview reports the file/byte totals and says outright that the receiving side
/// was not inspected (`exact: false`) rather than quietly reporting zero
/// overwrites, which would read as "this replaces nothing".
const PUSH_PREVIEW_STAT_CAP: usize = 2000;

/// Cap on the named paths a preview carries back. The count is always exact
/// (`destructive_total`); the list is only what the dialog shows.
const PREVIEW_NAME_CAP: usize = 24;

/// What a pull or push would actually do, read **before** it runs — the numbers
/// behind the confirmation every transfer now asks for.
///
/// Byte-sync's two manual transfers each write one side's bytes over the other's,
/// and both used to be a single unconfirmed click on a file *or a whole folder*.
/// That is fine when the receiving side has nothing, and is data loss when it has
/// edits nobody else holds — from the button alone the two are indistinguishable,
/// which is exactly what made the click dangerous. So the frontend asks first, and
/// this is what it asks *with*: how much would move, how much of it lands on top
/// of an existing file, and — the load-bearing number — how many of those carry
/// changes that exist nowhere else and would be gone.
///
/// Read-only: it walks and stats, it never transfers, records a base or touches
/// the manifest.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTransferPreview {
    /// Files the transfer would write.
    pub files: usize,
    /// Their total size in bytes (source side).
    pub bytes: u64,
    /// How many of them already exist on the *receiving* side (i.e. would be
    /// replaced rather than created).
    pub overwrites: usize,
    /// Receiving-side paths whose current content would be **lost**: for a pull,
    /// mirror files edited since the last sync; for a forced push, host files that
    /// moved since the last sync. Capped at [`PREVIEW_NAME_CAP`] entries.
    pub destructive: Vec<String>,
    /// The full count behind `destructive` (which is only the shown prefix).
    pub destructive_total: usize,
    /// Push only, non-forced: files that would be BLOCKED as stale and queued for
    /// per-file resolution instead of written.
    pub conflicts: usize,
    /// Git-tracked files omitted because lockstep owns them and moves them as
    /// commits instead of loose bytes.
    pub tracked: usize,
    /// Whether the receiving side was actually inspected. False when the push
    /// preview gave up on per-file stats (see [`PUSH_PREVIEW_STAT_CAP`]) **or**
    /// when a host stat errored out — the overwrite/destructive/conflict counts
    /// are then unknown, not zero, and the dialog must keep saying so rather than
    /// promising that nothing on the far side is replaced.
    pub exact: bool,
}

/// Apply the same tracked-tree ownership split as the background byte-sync
/// engine. Returns the byte-sync candidates plus the number left to lockstep.
fn drop_lockstep_tracked<T>(
    project_id: &str,
    files: Vec<T>,
    rel: impl Fn(&T) -> &str,
) -> (Vec<T>, usize) {
    let enabled = crate::services::git_peer::load_state(project_id).enabled;
    let tracked = crate::services::git_peer::tracked_paths(project_id);
    drop_tracked_files(files, &tracked, enabled, rel)
}

fn drop_tracked_files<T>(
    files: Vec<T>,
    tracked: &HashSet<String>,
    enabled: bool,
    rel: impl Fn(&T) -> &str,
) -> (Vec<T>, usize) {
    if !enabled || tracked.is_empty() {
        return (files, 0);
    }
    let before = files.len();
    let kept = files
        .into_iter()
        .filter(|file| !tracked.contains(rel(file)))
        .collect::<Vec<_>>();
    let omitted = before - kept.len();
    (kept, omitted)
}

/// Price a pull or push before it runs (see [`SyncTransferPreview`]).
///
/// `direction` is `"pull"` (host → mirror) or `"push"` (mirror → host).
/// `rel_paths`, when given, is an explicit file list (the diverged-files view's
/// bulk resolve) and replaces the subtree walk of `rel_path`; otherwise `rel_path`
/// is walked exactly as the transfer itself would walk it, exclusions included, so
/// the numbers describe the transfer that is actually about to happen.
/// `force` mirrors `sync_push`'s flag: it turns what would have been a blocked
/// conflict into a destroyed host file, which is the difference the dialog exists
/// to state.
#[tauri::command]
pub async fn sync_transfer_preview(
    project_id: String,
    rel_path: String,
    direction: String,
    force: bool,
    rel_paths: Option<Vec<String>>,
    pool: State<'_, RemotePoolState>,
    manifest: State<'_, SyncManifestState>,
) -> Result<SyncTransferPreview, String> {
    let (target, sftp) = resolve(&project_id, pool.inner()).await?;
    match direction.as_str() {
        "pull" => {
            preview_pull(
                &project_id,
                &target,
                &sftp,
                &rel_path,
                rel_paths,
                manifest.inner(),
            )
            .await
        }
        "push" => {
            preview_push(
                &project_id,
                &target,
                &sftp,
                &rel_path,
                rel_paths,
                force,
                manifest.inner(),
            )
            .await
        }
        other => Err(format!("unknown sync direction '{other}'")),
    }
}

/// The pull half of [`sync_transfer_preview`]: walk the host side, then ask the
/// mirror what it is about to lose.
async fn preview_pull(
    project_id: &str,
    target: &RemoteTarget,
    sftp: &Sftp,
    rel: &str,
    rel_paths: Option<Vec<String>>,
    manifest: &SyncManifestState,
) -> Result<SyncTransferPreview, String> {
    // Source side: the same host files `pull_subtree` would transfer.
    let files: Vec<remote_sync::HostFile> = match rel_paths {
        Some(paths) => {
            let mut out = Vec::with_capacity(paths.len());
            for p in paths {
                let host_abs = join_remote(&target.spec.remote_path, &p);
                let (size, mtime) = remote_sync::stat_or_zero(sftp, &host_abs).await;
                out.push(remote_sync::HostFile {
                    rel: p,
                    size,
                    mtime,
                });
            }
            out
        }
        None => match remote_sync::walk_host_files(sftp, &target.spec.remote_path, rel).await {
            Ok(f) => f,
            Err(_) => {
                // Not a directory — a single file, exactly as `pull_subtree` falls back.
                let host_abs = join_remote(&target.spec.remote_path, rel);
                let (size, mtime) = sftp::metadata_on(sftp, &host_abs).await?;
                vec![remote_sync::HostFile {
                    rel: rel.to_string(),
                    size,
                    mtime,
                }]
            }
        },
    };
    let files: Vec<remote_sync::HostFile> = {
        let mut guard = manifest.lock().await;
        let m = ensure_loaded(&mut guard, project_id);
        files
            .into_iter()
            .filter(|f| !remote_sync::is_excluded(m, &f.rel, rel))
            .collect()
    };
    let (files, tracked) = drop_lockstep_tracked(project_id, files, |f| &f.rel);

    let bytes = files.iter().map(|f| f.size).sum();
    let overwrites = files
        .iter()
        .filter(|f| mirror_local_path(project_id, &f.rel).is_file())
        .count();
    let rels: Vec<String> = files.iter().map(|f| f.rel.clone()).collect();
    // The same rule `pull_subtree` files a local-loss warning for, asked *before*
    // the transfer instead of reported after it.
    let doomed = unsynced_local_edits(project_id, manifest, &rels).await;
    Ok(SyncTransferPreview {
        files: files.len(),
        bytes,
        overwrites,
        destructive_total: doomed.len(),
        destructive: doomed.into_iter().take(PREVIEW_NAME_CAP).collect(),
        conflicts: 0,
        tracked,
        exact: true,
    })
}

/// The push half of [`sync_transfer_preview`]: walk the mirror, then re-stat the
/// host per file exactly as `sync_push` does — up to [`PUSH_PREVIEW_STAT_CAP`].
async fn preview_push(
    project_id: &str,
    target: &RemoteTarget,
    sftp: &Sftp,
    rel: &str,
    rel_paths: Option<Vec<String>>,
    force: bool,
    manifest: &SyncManifestState,
) -> Result<SyncTransferPreview, String> {
    let files = match rel_paths {
        Some(paths) => paths,
        None => remote_sync::walk_mirror_files(project_id, rel)?,
    };
    let files: Vec<String> = {
        let mut guard = manifest.lock().await;
        let m = ensure_loaded(&mut guard, project_id);
        files
            .into_iter()
            .filter(|f| !remote_sync::is_excluded(m, f, rel))
            .collect()
    };
    let (files, tracked) = drop_lockstep_tracked(project_id, files, String::as_str);
    let bytes = files
        .iter()
        .filter_map(|r| std::fs::metadata(mirror_local_path(project_id, r)).ok())
        .map(|m| m.len())
        .sum();

    if files.len() > PUSH_PREVIEW_STAT_CAP {
        return Ok(SyncTransferPreview {
            files: files.len(),
            bytes,
            tracked,
            exact: false,
            ..Default::default()
        });
    }

    let mut overwrites = 0usize;
    let mut conflicts = 0usize;
    let mut unchecked = 0usize;
    let mut doomed: Vec<String> = Vec::new();
    for r in &files {
        let host_abs = join_remote(&target.spec.remote_path, r);
        // Tri-state, for the same reason the manifest prune is tri-state: a stat
        // that FAILED (permission, dropped session) is not a host file that is
        // absent. Collapsing the two used to only *undercount* an overwrite, which
        // was invisible; now that a settled `overwrites == 0` is what makes the
        // dialog say "nothing on the host is replaced", an error read as absence
        // would be a false reassurance in exactly the case that deserves the
        // warning. So an unchecked file drops `exact`, which puts the dialog back
        // on "the receiving side could not be checked".
        let host = match sftp::metadata_opt_on(sftp, &host_abs).await {
            Ok(v) => v,
            Err(_) => {
                unchecked += 1;
                None
            }
        };
        if host.is_some() {
            overwrites += 1;
        }
        let base = {
            let mut guard = manifest.lock().await;
            let m = ensure_loaded(&mut guard, project_id);
            m.get(r).cloned().unwrap_or_default()
        };
        if remote_sync::push_decision(&base, host) == PushDecision::Stale {
            // Stale means the host moved past our base. Without `force` the push
            // blocks and asks; with it, that host copy is what gets destroyed.
            if force {
                doomed.push(r.clone());
            } else {
                conflicts += 1;
            }
        }
    }
    Ok(SyncTransferPreview {
        files: files.len(),
        bytes,
        overwrites,
        destructive_total: doomed.len(),
        destructive: doomed.into_iter().take(PREVIEW_NAME_CAP).collect(),
        conflicts,
        tracked,
        exact: unchecked == 0,
    })
}

/// Result of a local→remote push: how many files were written, which
/// project-relative paths were blocked by a stale host base (only populated when
/// `force` is false — the frontend prompts per conflict and re-calls with the
/// user's choice), and which ones the transfer itself failed on.
///
/// The failure half exists because a per-file error is NOT a command error: one
/// unwritable path must not abort the other nine hundred, so the loop logs and
/// carries on. It used to log to stderr and nowhere else, which made the two
/// outcomes a user cares about most — "it pushed nothing because the host refused
/// every write" and "it pushed everything" — render identically as a button that
/// did nothing. `failed_total` is the count; `failed` is a capped sample of the
/// names and `first_error` the first message, because *why* is the actionable
/// half and repeating one permission-denied per file is not.
#[derive(Debug, Clone, Serialize)]
pub struct SyncPushResult {
    pub pushed: usize,
    pub conflicts: Vec<String>,
    pub failed_total: usize,
    pub failed: Vec<String>,
    pub first_error: Option<String>,
    /// Files dropped by the exclusion filter before any transfer was attempted —
    /// the count that distinguishes "pushed nothing because nothing qualified"
    /// from "pushed everything".
    pub skipped_excluded: usize,
    /// Files omitted because enabled git lockstep owns their tracked paths.
    pub skipped_tracked: usize,
}

/// Push a local mirror file or folder subtree to the host (the bidirectional
/// other half of `sync_pull`). For each file: re-stat the host and compare to the
/// manifest base. A file whose host base is unchanged (or that the host doesn't
/// have yet) is written atomically (temp + rename). A file whose host moved since
/// the last sync is BLOCKED and returned in `conflicts` — unless `force` is set
/// (the user chose "keep local"), which overwrites it. Never silently clobbers.
#[tauri::command]
pub async fn sync_push(
    app: AppHandle,
    project_id: String,
    rel_path: String,
    force: bool,
    pool: State<'_, RemotePoolState>,
    manifest: State<'_, SyncManifestState>,
) -> Result<SyncPushResult, String> {
    let (target, sftp) = resolve(&project_id, pool.inner()).await?;
    let files = remote_sync::walk_mirror_files(&project_id, &rel_path)?;
    let walked = files.len();
    // Excluded folders are excluded in BOTH directions: a mirror-side copy of an
    // excluded tree (an earlier pull, a local build) must not be pushed up either.
    let files: Vec<String> = {
        let mut guard = manifest.lock().await;
        let m = ensure_loaded(&mut guard, &project_id);
        files
            .into_iter()
            .filter(|rel| !remote_sync::is_excluded(m, rel, &rel_path))
            .collect()
    };
    let skipped_excluded = walked - files.len();
    let (files, skipped_tracked) = drop_lockstep_tracked(&project_id, files, String::as_str);
    // A targeted push (a named file/folder) with zero candidates is a click that
    // would silently do nothing — say why instead. Whole-mirror pushes ("") keep
    // returning Ok: an empty mirror is a legitimate steady state there.
    if files.is_empty() && !rel_path.is_empty() {
        return Err(if skipped_tracked > 0 && skipped_excluded == 0 {
            format!(
                "'{rel_path}' is git-tracked and travels as a commit through Git Lockstep — \
                 nothing was byte-pushed"
            )
        } else if walked > 0 {
            format!("'{rel_path}' is excluded from sync — nothing was pushed")
        } else {
            format!(
                "'{rel_path}' has nothing to push — not present in the local mirror \
                 (or a symlink/nested-repo subtree, which byte-sync never pushes)"
            )
        });
    }
    let total = files.len();
    emit(&app, &project_id, "start", &rel_path, 0, total);
    let mut pushed = 0usize;
    let mut conflicts = Vec::new();
    let mut failed: Vec<String> = Vec::new();
    let mut failed_total = 0usize;
    let mut first_error: Option<String> = None;
    let mut done = 0usize;
    // What one file's bounded remote work resolved to (a conflict costs no transfer;
    // a push carries the new host base back for the manifest).
    enum PushStep {
        Conflict,
        Pushed((u64, Option<u64>)),
    }
    for rel in files {
        let host_abs = join_remote(&target.spec.remote_path, &rel);
        // Snapshot the base under the lock (released before the transfer).
        let base = {
            let mut guard = manifest.lock().await;
            let m = ensure_loaded(&mut guard, &project_id);
            m.get(&rel).cloned().unwrap_or_default()
        };
        let local = mirror_local_path(&project_id, &rel);
        // Bound every SFTP round-trip for this file: the host re-stat AND the write
        // both ride the pooled session, and either can hang forever on a session
        // that has silently dropped (see `PUSH_FILE_TIMEOUT`). `timeout` turns that
        // into a per-file outcome the loop can act on instead of a wedged command.
        let outcome = tokio::time::timeout(PUSH_FILE_TIMEOUT, async {
            let host = sftp::metadata_on(&sftp, &host_abs).await.ok();
            if remote_sync::push_decision(&base, host) == PushDecision::Stale && !force {
                return Ok::<PushStep, String>(PushStep::Conflict);
            }
            let hm = remote_sync::push_file_atomic(&sftp, &local, &host_abs).await?;
            Ok(PushStep::Pushed(hm))
        })
        .await;
        let mut stalled = false;
        match outcome {
            Ok(Ok(PushStep::Conflict)) => conflicts.push(rel.clone()),
            Ok(Ok(PushStep::Pushed((hs, hm)))) => {
                let (ls, lm) = local_size_mtime(std::fs::metadata(&local).ok());
                let mut guard = manifest.lock().await;
                let m = ensure_loaded(&mut guard, &project_id);
                remote_sync::record_push(m, &rel, hs, hm, ls, lm);
                let _ = remote_sync::save_manifest(&project_id, m);
                net_usage::record_files(&project_id, 0, 1);
                pushed += 1;
            }
            Ok(Err(e)) => {
                eprintln!("sync_push: skip '{rel}': {e}");
                failed_total += 1;
                if failed.len() < PREVIEW_NAME_CAP {
                    failed.push(rel.clone());
                }
                if first_error.is_none() {
                    first_error = Some(e);
                }
            }
            Err(_elapsed) => {
                // A stall is a fault of the *connection*, not of this file: every
                // remaining file would time out the same way (each still blocking
                // the UI for a full `PUSH_FILE_TIMEOUT`), so abandon the walk here
                // rather than plod through 47 identical timeouts. The `done` emit
                // below still fires, clearing the frozen progress and freeing the
                // session for other pushes.
                eprintln!(
                    "sync_push: '{rel}' stalled after {}s — abandoning the rest",
                    PUSH_FILE_TIMEOUT.as_secs()
                );
                failed_total += 1;
                if failed.len() < PREVIEW_NAME_CAP {
                    failed.push(rel.clone());
                }
                if first_error.is_none() {
                    first_error = Some(format!(
                        "transfer of '{rel}' stalled after {}s — the remote connection \
                         may have dropped; reconnect and push again",
                        PUSH_FILE_TIMEOUT.as_secs()
                    ));
                }
                stalled = true;
            }
        }
        done += 1;
        emit(&app, &project_id, "file", &rel, done, total);
        if stalled {
            break;
        }
    }
    emit(&app, &project_id, "done", &rel_path, done, total);
    Ok(SyncPushResult {
        pushed,
        conflicts,
        failed_total,
        failed,
        first_error,
        skipped_excluded,
        skipped_tracked,
    })
}

/// Unified diff of the local mirror copy (old / "local") against the current host
/// copy (new / "host") for one file. Backs the file-tree's diverged (amber) diff
/// button: the host moved past our mirrored base, so this shows exactly what
/// changed on the host before the user re-syncs. Requires a live pooled
/// connection (reads the host over SFTP); a cold pool errors via `resolve`.
#[tauri::command]
pub async fn sync_diff(
    project_id: String,
    rel_path: String,
    pool: State<'_, RemotePoolState>,
) -> Result<String, String> {
    let (target, sftp) = resolve(&project_id, pool.inner()).await?;
    let host_abs = join_remote(&target.spec.remote_path, &rel_path);
    // Host bytes now (empty if the host no longer has the file → shown as a full
    // deletion by the diff).
    let host_bytes = sftp::read_file_on(&sftp, &host_abs)
        .await
        .unwrap_or_default();
    let mirror_path = mirror_local_path(&project_id, &rel_path);
    // Compute the diff LOCALLY (never over SSH — the mirror is on disk and the
    // host bytes are already in memory). Off the async thread: git spawns a
    // subprocess.
    let rel = rel_path.clone();
    tokio::task::spawn_blocking(move || diff_mirror_vs_host(&mirror_path, &host_bytes, &rel))
        .await
        .map_err(|e| format!("sync_diff task failed: {e}"))?
}

// ── Internals ──────────────────────────────────────────────────────────────

/// The paths, among `rels`, whose mirror copy holds edits that exist **nowhere else**,
/// and which the pull about to run will therefore overwrite and lose (#28q).
///
/// A pull is the one byte-sync operation that destroys something: it writes the host's
/// bytes over the mirror's, including the per-file and whole-project pull actions that
/// resolve amber by choosing the host. Which reads as bringing things
/// in step, and is also, silently, choosing the host and discarding the local edit. The
/// auto-sync engine never does this (it skips an amber file rather than pick a winner);
/// only the manual commands do, and only because the user asked. So: not blocked, but
/// no longer silent.
///
/// A path qualifies only when we can be sure there was something to lose: it has a
/// recorded base (byte-sync has synced it before — so the base is a real "as of" mark,
/// not a zeroed default), its mirror file is still there (a pull that *creates* a file
/// destroys nothing), and its current size/mtime differ from that base. That is the same
/// local-divergence rule the file tree already paints amber, so the warning names
/// exactly the files the user was already being shown as locally changed.
async fn unsynced_local_edits(
    project_id: &str,
    manifest: &SyncManifestState,
    rels: &[String],
) -> Vec<String> {
    let mut guard = manifest.lock().await;
    let m = ensure_loaded(&mut guard, project_id);
    rels.iter()
        .filter(|rel| {
            let Some(entry) = m.get(rel.as_str()) else {
                return false; // never synced → no base to have diverged from
            };
            if entry.last_pull_ts.is_none() && entry.last_push_ts.is_none() {
                return false;
            }
            let Some(meta) = std::fs::metadata(mirror_local_path(project_id, rel)).ok() else {
                return false; // no mirror file → the pull only creates
            };
            let (_, local_changed) = remote_sync::divergence(entry, None, Some(local_meta(&meta)));
            local_changed
        })
        .cloned()
        .collect()
}

/// File the warning for the local edits a pull just overwrote. Called with the list
/// captured *before* the transfer — afterwards the evidence is, by definition, gone.
fn warn_overwritten(project_id: &str, op: &str, paths: Vec<String>) {
    local_loss::record_paths(
        project_id,
        local_loss::LossSource::Sync,
        local_loss::LossKind::Overwritten,
        op,
        paths,
        None, // the edits were only ever in the mirror — there is nowhere to get them back from
    );
}

/// Pull `rel` (a single file OR a whole folder subtree) from the host into the
/// mirror, recording each file's base in the manifest. Shared by `sync_pull` and
/// `sync_whole_project`.
///
/// For a directory, the bulk transfer prefers the rsync fast-path (delta +
/// single connection, riding the ControlMaster) when rsync is present on BOTH
/// ends, falling back to the SFTP-native per-file walker (the floor) when it is
/// missing or rsync fails. Either way the manifest bases come from the host walk
/// (metadata only — no extra byte transfer) plus a local stat.
async fn pull_subtree(
    app: &AppHandle,
    project_id: &str,
    target: &RemoteTarget,
    sftp: &Sftp,
    rel: &str,
    manifest: &SyncManifestState,
) -> Result<remote_sync::PullOutcome, String> {
    // Determine whether `rel` is a directory (walkable) or a single file.
    let (files, is_dir) =
        match remote_sync::walk_host_files(sftp, &target.spec.remote_path, rel).await {
            Ok(f) => (f, true),
            Err(_) => {
                // Not a directory — treat `rel` as a single file (stat it).
                let host_abs = join_remote(&target.spec.remote_path, rel);
                let (size, mtime) = crate::services::sftp::metadata_on(sftp, &host_abs).await?;
                (
                    vec![remote_sync::HostFile {
                        rel: rel.to_string(),
                        size,
                        mtime,
                    }],
                    false,
                )
            }
        };
    // Drop everything the user excluded from byte-sync (the giant-folder prompt,
    // `services::big_folders`). A whole-project pull is exactly the click that
    // answer exists to make safe; an explicit pull *of* the excluded folder still
    // goes through, which is why its own marker is ignored (`is_excluded`'s `under`).
    let (files, skipped_excluded) = {
        let mut guard = manifest.lock().await;
        let m = ensure_loaded(&mut guard, project_id);
        let before = files.len();
        let kept: Vec<_> = files
            .into_iter()
            .filter(|f| !remote_sync::is_excluded(m, &f.rel, rel))
            .collect();
        let skipped = before - kept.len();
        (kept, skipped)
    };
    let walked = files.len() + skipped_excluded;
    let (files, skipped_tracked) = drop_lockstep_tracked(project_id, files, |file| &file.rel);
    // The pull twin of `sync_push`'s refusal: a targeted pull (a named file or folder)
    // whose every candidate was withheld used to return `Ok(0)`, which the tree then
    // reported as "pulled" — the exact silent no-op a tracked file's orange row
    // produced when its "take host" was clicked. A whole-project pull ("") keeps
    // returning Ok: an empty host tree is a legitimate steady state there.
    if files.is_empty() && !rel.is_empty() {
        return Err(if skipped_tracked > 0 && skipped_excluded == 0 {
            format!(
                "'{rel}' is git-tracked and travels as a commit through Git Lockstep — \
                 nothing was byte-pulled"
            )
        } else if walked > 0 {
            format!("'{rel}' is excluded from sync — nothing was pulled")
        } else {
            format!("'{rel}' has nothing to pull — the host holds no regular file there")
        });
    }

    let total = files.len();
    emit(app, project_id, "start", rel, 0, total);

    // #28q: whichever transport wins below, a pull writes the host's bytes over the
    // mirror's. Name the local edits that destroys before either of them runs — after the
    // transfer the evidence is gone (rsync's fast path in particular leaves nothing to
    // compare a base against).
    let rels: Vec<String> = files.iter().map(|f| f.rel.clone()).collect();
    let doomed = unsynced_local_edits(project_id, manifest, &rels).await;
    warn_overwritten(project_id, "Pull from the host", doomed);

    // rsync fast-path for a directory pull: transfer the bytes in one shot, then
    // fall through to the manifest-recording loop (which only re-stats locally —
    // the bytes are already on disk, so `pull_file` would be a wasteful re-read).
    // It transfers the *whole* subtree, so it is given up entirely as soon as one
    // file inside was excluded — a fast path that ignores the exclusion would haul
    // the very folder the user just said to leave on the host.
    let rsynced = is_dir && skipped_excluded == 0 && try_rsync_pull(target, rel, &files).await;

    let mirror_root = remote_sync::mirror_dir(project_id);
    let mut done = 0usize;
    let mut outcome = remote_sync::PullOutcome::default();
    for file in files {
        let host_abs = join_remote(&target.spec.remote_path, &file.rel);
        let local = mirror_local_path(project_id, &file.rel);
        // rsync already wrote the bytes; only lstat locally to capture the base,
        // and record only a regular file within the cap (gap 35): an oversized
        // file was left out of the transfer, and whatever else a changing host
        // tree slipped past the walk is skipped like the floor would.
        // Otherwise pull the file over SFTP (which confines the write, #863).
        let local_base = if rsynced {
            remote_sync::rsync_pulled_base(&local, file.size)
        } else {
            remote_sync::pull_file(sftp, &host_abs, file.size, &mirror_root, &file.rel)
                .await
                .ok()
        };
        outcome.tally(&file, local_base.is_some());
        match local_base {
            Some((ls, lm)) => {
                let mut guard = manifest.lock().await;
                let m = ensure_loaded(&mut guard, project_id);
                remote_sync::record_pull(m, &file.rel, file.size, file.mtime, ls, lm);
                let _ = remote_sync::save_manifest(project_id, m);
                net_usage::record_files(project_id, 1, 0);
            }
            None => {
                // A single oversized/unreadable file shouldn't abort the whole
                // folder sync; carry on. One over the cap is in the outcome
                // for the UI to name (gap 35); the rest stay a stderr line.
                eprintln!("sync_pull: skip '{}'", file.rel);
            }
        }
        done += 1;
        emit(app, project_id, "file", &file.rel, done, total);
    }
    emit(app, project_id, "done", rel, done, total);
    Ok(outcome)
}

/// Attempt the rsync fast-path for a directory pull of `rel`: probe rsync on both
/// ends, and if present run `rsync_pull_dir` on a blocking thread. Returns `true`
/// when rsync actually transferred (the caller then just stats locally); `false`
/// to fall back to the SFTP walker. Best-effort — any probe/transfer failure
/// returns `false`.
async fn try_rsync_pull(target: &RemoteTarget, rel: &str, files: &[remote_sync::HostFile]) -> bool {
    if !remote_sync::rsync_available_local() {
        return false;
    }
    // The floor refuses a file over the cap; so does the fast path (gap 35).
    let within_cap = remote_sync::rsync_transfer_list(files);
    if within_cap.is_empty() {
        return false;
    }
    let Some(rsync_files) = remote_sync::rsync_subtree_files(&within_cap, rel) else {
        return false;
    };
    let spec = target.spec.clone();
    let host_src = join_remote(&spec.remote_path, rel);
    // #863: rsync writes THROUGH its destination, so a symlink at or above it
    // inside the mirror (a fenced agent can plant one) must not be the target.
    // Below it rsync replaces a symlinked directory rather than following it.
    // Refused → the SFTP floor, whose per-file writes are confined too.
    let Ok(local_dest) =
        remote_sync::confined_mirror_dir(&remote_sync::mirror_dir(&target.project_id), rel)
    else {
        return false;
    };
    tokio::task::spawn_blocking(move || {
        if !remote_sync::rsync_available_host(&spec) {
            return false;
        }
        remote_sync::rsync_pull_dir(
            &spec.user,
            &spec.host,
            spec.port,
            &host_src,
            &local_dest,
            &rsync_files,
        )
        .is_ok()
    })
    .await
    .unwrap_or(false)
}

/// Produce a unified diff of `mirror_path` (old / "local") vs `host_bytes`
/// (new / "host") using local `git diff --no-index`. `git` is a hard dependency
/// and `--no-index` works outside any repo, exiting non-zero when the files
/// differ (the normal case) — so non-empty stdout is treated as success,
/// mirroring `git_diff_file_blocking`. The host bytes are staged in a temp file;
/// an absent mirror (never pulled) diffs against an empty temp file so it shows
/// as all-additions. The temp/abs paths in the header lines are rewritten to
/// friendly `local/<rel>` / `host/<rel>` labels. Returns "" when identical.
fn diff_mirror_vs_host(
    mirror_path: &std::path::Path,
    host_bytes: &[u8],
    rel: &str,
) -> Result<String, String> {
    use std::io::Write;
    let mut host_tmp = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
    host_tmp.write_all(host_bytes).map_err(|e| e.to_string())?;
    host_tmp.flush().map_err(|e| e.to_string())?;
    let host_tmp_path = host_tmp.path().to_string_lossy().into_owned();

    // Old side: the mirror file if present, else an empty temp stand-in for
    // /dev/null (portable across platforms). Both temps stay alive until the git
    // call returns below.
    let empty_tmp = if mirror_path.exists() {
        None
    } else {
        Some(tempfile::NamedTempFile::new().map_err(|e| e.to_string())?)
    };
    let mirror_arg = match &empty_tmp {
        Some(t) => t.path().to_string_lossy().into_owned(),
        None => mirror_path.to_string_lossy().into_owned(),
    };

    let out = crate::paths::command_no_window("git")
        .args(["diff", "--no-index", "--", &mirror_arg, &host_tmp_path])
        .output()
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    if stdout.is_empty() {
        // Zero exit + no output = identical. Non-zero + no output = a real error.
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).to_string());
        }
        return Ok(String::new());
    }
    Ok(rewrite_diff_labels(&stdout, rel))
}

/// Rewrite the temp/abs paths in a `git diff --no-index` output to friendly
/// `a/local/<rel>` and `b/host/<rel>` header labels. Operates on the header LINES
/// (not raw substrings): git formats an absolute path as `a/tmp/…` — the leading
/// `/` folds into the `a/` prefix, so a naive path replacement would eat the
/// prefix. The frontend's diff parser strips the `a/`/`b/` prefixes, leaving a
/// clean `local/<rel>` / `host/<rel>` shown in the diff header.
fn rewrite_diff_labels(diff: &str, rel: &str) -> String {
    let local = format!("local/{rel}");
    let host = format!("host/{rel}");
    let mut out = String::with_capacity(diff.len());
    for line in diff.split_inclusive('\n') {
        let trimmed = line.strip_suffix('\n').unwrap_or(line);
        let nl = if line.ends_with('\n') { "\n" } else { "" };
        if trimmed.starts_with("diff --git ") {
            out.push_str(&format!("diff --git a/{local} b/{host}{nl}"));
        } else if trimmed.starts_with("--- ") {
            out.push_str(&format!("--- a/{local}{nl}"));
        } else if trimmed.starts_with("+++ ") {
            out.push_str(&format!("+++ b/{host}{nl}"));
        } else if trimmed.starts_with("Binary files ") {
            out.push_str(&format!("Binary files a/{local} and b/{host} differ{nl}"));
        } else {
            out.push_str(line);
        }
    }
    out
}

/// Emit one `sync-progress` event (best-effort).
fn emit(app: &AppHandle, project_id: &str, phase: &str, rel_path: &str, done: usize, total: usize) {
    let _ = app.emit(
        "sync-progress",
        SyncProgress {
            project_id: project_id.to_string(),
            phase: phase.to_string(),
            rel_path: rel_path.to_string(),
            done,
            total,
        },
    );
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::{drop_tracked_files, rewrite_diff_labels};

    #[test]
    fn manual_candidates_drop_the_tracked_set_when_lockstep_is_enabled() {
        let files = vec!["src/main.rs".to_string(), "notes.txt".to_string()];
        let tracked = HashSet::from(["src/main.rs".to_string()]);
        let (kept, omitted) = drop_tracked_files(files.clone(), &tracked, true, String::as_str);
        assert_eq!(kept, vec!["notes.txt"]);
        assert_eq!(omitted, 1);

        let (kept, omitted) = drop_tracked_files(files.clone(), &tracked, false, String::as_str);
        assert_eq!(kept, files);
        assert_eq!(omitted, 0);
    }

    #[test]
    fn turning_auto_on_lifts_an_exclusion_and_off_records_a_carve_out() {
        use crate::services::remote_sync::{is_auto, is_excluded, Manifest, SyncEntry};
        // The giant-folder prompt's answer: excluded, auto forced off.
        let mut e = SyncEntry {
            is_dir: true,
            excluded: true,
            auto_off: true,
            ..Default::default()
        };
        super::apply_auto_marker(&mut e, true, true);
        assert!(e.auto_sync && e.selected && !e.auto_off);
        assert!(!e.excluded, "auto-on must lift the exclusion or it is a no-op");
        // …and the two nearest-marker walks now agree the subtree is in scope.
        let mut m = Manifest::new();
        m.insert("data".into(), e.clone());
        assert!(is_auto(&m, "data/x.bin"));
        assert!(!is_excluded(&m, "data/x.bin", ""));

        super::apply_auto_marker(&mut e, false, true);
        assert!(!e.auto_sync && e.auto_off);
        assert!(e.selected, "off leaves manual tracking alone");
        assert!(!e.excluded, "off is a carve-out, not an exclusion");
    }

    #[test]
    fn rewrite_diff_labels_relabels_both_sides() {
        // Real `git diff --no-index` output for two absolute temp paths: git folds
        // the leading `/` into the `a/`/`b/` prefix (`a/tmp/.mirrorAAA`).
        let raw = "\
diff --git a/tmp/.mirrorAAA b/tmp/.hostBBB
index 3367afd..3e75765 100644
--- a/tmp/.mirrorAAA
+++ b/tmp/.hostBBB
@@ -1 +1 @@
-old
+new
";
        let out = rewrite_diff_labels(raw, "src/main.rs");
        // Header lines carry friendly labels; the parser strips git's a/ b/
        // prefixes, leaving `local/…` / `host/…`. Body/hunk lines are untouched.
        assert!(
            out.contains("diff --git a/local/src/main.rs b/host/src/main.rs"),
            "got: {out}"
        );
        assert!(out.contains("--- a/local/src/main.rs"), "got: {out}");
        assert!(out.contains("+++ b/host/src/main.rs"), "got: {out}");
        assert!(out.contains("-old"), "got: {out}");
        assert!(out.contains("+new"), "got: {out}");
        assert!(!out.contains(".mirrorAAA"));
        assert!(!out.contains(".hostBBB"));
    }

    #[test]
    fn rewrite_diff_labels_handles_binary() {
        let raw = "diff --git a/tmp/x b/tmp/y\nBinary files a/tmp/x and b/tmp/y differ\n";
        let out = rewrite_diff_labels(raw, "data/img.png");
        assert!(
            out.contains("Binary files a/local/data/img.png and b/host/data/img.png differ"),
            "got: {out}"
        );
    }
}

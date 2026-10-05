//! Worker code sync — one-way, code-only push fan-out (`docs/multi_host_remote_plan.md` §2).
//!
//! The canonical source is the **local mirror** — already lockstep-paired with the
//! primary (`git_peer`), so it always holds the project's current committed code.
//! Each extra "worker" host (`schema::project::ComputeHost`) is fed *from the
//! mirror*, one-way, tracked files only:
//!
//! 1. On the mirror, `git bundle` the current HEAD (incremental `--not <last_head>`
//!    when we know what the worker already has).
//! 2. Ship the bundle to `worker:<remote_path>/.tabtivity-worker.bundle` over the
//!    worker's pooled SFTP session.
//! 3. On the worker: `git init` (idempotent), `git fetch` the bundle, then
//!    `git reset --hard FETCH_HEAD` — **tracked files only, never `git clean`**.
//!
//! This inherits none of the hard parts of the primary's bidirectional lockstep:
//! a worker tree is never read back, so there is no divergence, no conflict, and no
//! destructive local-loss to audit. The single load-bearing invariant is that the
//! worker sync **must never `git clean`** — untracked experiment outputs survive
//! every sync by construction (plan §8).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

use crate::services::git_peer::{bundle_create_args, Peer};
use crate::services::remote::{self, RemotePoolState, PRIMARY_HOST};
use crate::services::remote_sync::mirror_dir;
use crate::services::{sftp, ssh_exec};
use crate::storage;

/// The bundle filename shipped into a worker's `remote_path`. A relative name, so
/// the worker-side script (which runs `cd <remote_path> && …`) never has to
/// interpolate a path.
const WORKER_BUNDLE: &str = crate::brand::WORKER_BUNDLE;

/// In-memory fan-out registry: the `(project, host)` keys currently syncing, used
/// as a crude in-flight lock so a commit-triggered and a connect-triggered push to
/// the same worker never race to write its bundle file. The durable per-worker
/// `last_head` lives on disk (see [`worker_state_path`]).
#[derive(Default)]
pub struct WorkerSyncRegistry {
    in_flight: HashSet<String>,
}

/// Managed-state handle to the worker-sync registry.
pub type WorkerSyncState = Arc<Mutex<WorkerSyncRegistry>>;

/// Build a fresh, empty worker-sync registry for `tauri::Builder::manage`.
pub fn new_state() -> WorkerSyncState {
    Arc::new(Mutex::new(WorkerSyncRegistry::default()))
}

/// Durable per-worker state (`worker_sync.json`): the commit last successfully
/// pushed to this worker, so the next push can be an incremental bundle.
#[derive(Default, Serialize, Deserialize)]
struct WorkerRecord {
    #[serde(skip_serializing_if = "Option::is_none")]
    last_head: Option<String>,
}

/// The outcome of one worker fan-out, emitted to the frontend as a
/// `worker-sync-report` event so the "Remote machines…" section can show a
/// "last synced: <commit>" line.
#[derive(Clone, Serialize)]
pub struct WorkerSyncReport {
    pub project_id: String,
    pub host_id: String,
    /// The commit now on the worker's tracked tree (short sha), when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    pub ok: bool,
    /// Nothing to do — the worker is already at HEAD, or the mirror has no commit.
    pub skipped: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Where a worker's durable `worker_sync.json` lives: under the project's slot in
/// the local state dir, per host. Independent of the mirror so it survives a mirror
/// relocation.
fn worker_state_path(project_id: &str, host_id: &str) -> PathBuf {
    storage::state_dir()
        .join("remote-projects")
        .join(project_id)
        .join("workers")
        .join(format!("{host_id}.json"))
}

/// The local scratch path for a worker's outbound bundle (beside its state file).
fn local_bundle_path(project_id: &str, host_id: &str) -> PathBuf {
    storage::state_dir()
        .join("remote-projects")
        .join(project_id)
        .join("workers")
        .join(format!("{host_id}.bundle"))
}

fn read_record(project_id: &str, host_id: &str) -> WorkerRecord {
    let path = worker_state_path(project_id, host_id);
    if path.exists() {
        storage::read_json(&path).unwrap_or_default()
    } else {
        WorkerRecord::default()
    }
}

fn write_record(project_id: &str, host_id: &str, rec: &WorkerRecord) {
    let path = worker_state_path(project_id, host_id);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = storage::write_json(&path, rec);
}

/// The mirror's current HEAD commit sha, or `None` when the mirror has no commit
/// yet (unborn HEAD) or is unreadable.
fn mirror_head(mirror: &Path) -> Option<String> {
    let out = Peer::Local(mirror.to_path_buf())
        .run(&["rev-parse", "--verify", "--quiet", "HEAD"])
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let sha = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if sha.is_empty() {
        None
    } else {
        Some(sha)
    }
}

/// Build the outbound bundle on the mirror. `exclude` (the worker's `last_head`)
/// makes it a thin incremental bundle when the worker already has that commit.
/// Returns `Ok(true)` for git's "Refusing to create empty bundle" — i.e. nothing to
/// send — and `Ok(false)` when a bundle was written. Any other failure is `Err`.
fn build_bundle(mirror: &Path, bundle_path: &Path, exclude: Option<&str>) -> Result<bool, String> {
    if let Some(parent) = bundle_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let excludes: Vec<String> = exclude.map(|s| vec![s.to_string()]).unwrap_or_default();
    let path_str = bundle_path.to_string_lossy().to_string();
    // Positive is `HEAD` (a ref, not a raw sha — `git bundle` needs a ref name);
    // excludes are rev-list args and may be raw shas.
    let args = bundle_create_args(&path_str, &["HEAD"], &excludes);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = Peer::Local(mirror.to_path_buf()).run(&arg_refs)?;
    if out.status.success() {
        return Ok(false);
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    if stderr.contains("Refusing to create empty bundle") {
        return Ok(true); // worker already has HEAD — nothing to send
    }
    Err(format!("git bundle create failed: {}", stderr.trim()))
}

/// The constant worker-side script: init (idempotent), fetch the shipped bundle,
/// then move the **tracked** tree to it. It **never** `git clean`s, so untracked
/// experiment outputs survive; the bundle is removed after applying. Constant text
/// (no interpolation), so it is safe to hand to `run_remote_script`.
fn worker_apply_script() -> String {
    format!(
        "git init -q && \
         git fetch -q --no-tags {bundle} && \
         git -c advice.detachedHead=false reset -q --hard FETCH_HEAD && \
         rm -f {bundle}{legacy_bundle}",
        bundle = WORKER_BUNDLE,
        // A bundle an interrupted sync of an older build left behind.
        legacy_bundle = crate::brand::PAIR
            .legacy(crate::brand::Name::WORKER_BUNDLE)
            .map(|old| format!(" {old}"))
            .unwrap_or_default(),
    )
}

/// Push the mirror's current HEAD to one worker's tracked tree (plan §2). `force`
/// bypasses the "already at last_head" short-circuit (the manual "Sync code now").
///
/// Returns a [`WorkerSyncReport`]; it does **not** emit the event (the caller may
/// batch a fan-out). Blocking git + async SFTP are interleaved, so this awaits.
pub async fn sync_worker(
    pool: &RemotePoolState,
    project_id: &str,
    host_id: &str,
    force: bool,
) -> WorkerSyncReport {
    let report_err = |msg: String| WorkerSyncReport {
        project_id: project_id.to_string(),
        host_id: host_id.to_string(),
        head: None,
        ok: false,
        skipped: false,
        error: Some(msg),
    };

    if host_id == PRIMARY_HOST {
        return report_err("primary is not a worker".to_string());
    }
    // A SHARED-FILESYSTEM worker sees the primary's project folder directly, so
    // there is nothing to copy — and running git here would operate inside the
    // primary's real working tree. Never sync it; report a no-op skip. This is a
    // defensive guard (the connect path and `fan_out` already skip shared hosts),
    // so even a stray `worker_sync_now` on one can do no harm.
    if remote::compute_hosts_for(project_id)
        .into_iter()
        .any(|h| h.id == host_id && h.shared_fs)
    {
        return WorkerSyncReport {
            project_id: project_id.to_string(),
            host_id: host_id.to_string(),
            head: None,
            ok: true,
            skipped: true,
            error: None,
        };
    }
    let Some(target) = remote::remote_target_for_host(project_id, host_id) else {
        return report_err("unknown worker host".to_string());
    };
    let spec = target.spec;

    let mirror = mirror_dir(project_id);
    let Some(head) = mirror_head(&mirror) else {
        // Nothing committed yet — a worker legitimately has no code to receive.
        return WorkerSyncReport {
            project_id: project_id.to_string(),
            host_id: host_id.to_string(),
            head: None,
            ok: true,
            skipped: true,
            error: None,
        };
    };

    let last_head = read_record(project_id, host_id).last_head;
    if !force && last_head.as_deref() == Some(head.as_str()) {
        return WorkerSyncReport {
            project_id: project_id.to_string(),
            host_id: host_id.to_string(),
            head: Some(short_sha(&head)),
            ok: true,
            skipped: true,
            error: None,
        };
    }

    // Attempt an incremental bundle first (excluding the worker's last_head); on any
    // apply failure — most likely a missing prerequisite because the worker's tree
    // drifted from what we recorded — retry with a full bundle, which is always
    // correct (merely larger).
    let mut attempts: Vec<Option<String>> = Vec::new();
    if let Some(last) = last_head.clone() {
        attempts.push(Some(last));
    }
    attempts.push(None); // full bundle fallback (and first attempt when no last_head)

    let mut last_err: Option<String> = None;
    for exclude in attempts {
        match push_once(
            pool,
            project_id,
            host_id,
            &spec,
            &mirror,
            exclude.as_deref(),
        )
        .await
        {
            Ok(true) => {
                // Empty bundle — worker already at HEAD. Record and finish.
                write_record(
                    project_id,
                    host_id,
                    &WorkerRecord {
                        last_head: Some(head.clone()),
                    },
                );
                return WorkerSyncReport {
                    project_id: project_id.to_string(),
                    host_id: host_id.to_string(),
                    head: Some(short_sha(&head)),
                    ok: true,
                    skipped: true,
                    error: None,
                };
            }
            Ok(false) => {
                write_record(
                    project_id,
                    host_id,
                    &WorkerRecord {
                        last_head: Some(head.clone()),
                    },
                );
                return WorkerSyncReport {
                    project_id: project_id.to_string(),
                    host_id: host_id.to_string(),
                    head: Some(short_sha(&head)),
                    ok: true,
                    skipped: false,
                    error: None,
                };
            }
            Err(e) => last_err = Some(e),
        }
    }
    report_err(last_err.unwrap_or_else(|| "worker sync failed".to_string()))
}

/// One push attempt with a given `exclude`. `Ok(true)` = nothing to send (empty
/// bundle); `Ok(false)` = applied on the worker; `Err` = build/ship/apply failure.
async fn push_once(
    pool: &RemotePoolState,
    project_id: &str,
    host_id: &str,
    spec: &crate::schema::project::RemoteSpec,
    mirror: &Path,
    exclude: Option<&str>,
) -> Result<bool, String> {
    let bundle_path = local_bundle_path(project_id, host_id);

    // 1. Build the bundle on the mirror (blocking git).
    let mirror_owned = mirror.to_path_buf();
    let bundle_owned = bundle_path.clone();
    let exclude_owned = exclude.map(str::to_string);
    let empty = tauri::async_runtime::spawn_blocking(move || {
        build_bundle(&mirror_owned, &bundle_owned, exclude_owned.as_deref())
    })
    .await
    .map_err(|e| e.to_string())??;
    if empty {
        return Ok(true);
    }

    // 2. Ensure the worker root exists and ship the bundle over its pooled SFTP.
    let spec_for_mkdir = spec.clone();
    tauri::async_runtime::spawn_blocking(move || ssh_exec::remote_mkdir_p(&spec_for_mkdir))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("could not create worker dir: {e}"))?;

    let remote_bundle = format!(
        "{}/{}",
        spec.remote_path.trim_end_matches('/'),
        WORKER_BUNDLE
    );
    let sftp = remote::pooled_sftp_host(pool, project_id, host_id)
        .await
        .ok_or_else(|| "worker not connected".to_string())?;
    sftp::upload_file_streaming_on(&sftp, &bundle_path, &remote_bundle).await?;
    let _ = std::fs::remove_file(&bundle_path);

    // 3. Apply on the worker (blocking ssh). Tracked files only — never git clean.
    let spec_for_apply = spec.clone();
    let out = tauri::async_runtime::spawn_blocking(move || {
        ssh_exec::run_remote_script(&spec_for_apply, &worker_apply_script())
    })
    .await
    .map_err(|e| e.to_string())??;
    if !out.status.success() {
        return Err(format!(
            "worker apply failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(false)
}

/// A short (7-char) sha for display, unchanged when already shorter.
fn short_sha(sha: &str) -> String {
    sha.chars().take(7).collect()
}

/// Whether a worker should receive the commit-triggered code fan-out. A
/// **shared-filesystem** worker never does — it has no copy of its own (its tree IS
/// the primary's, moved by the primary's own sync), and running git on it would
/// operate inside the primary's real working tree. A **synced-copy** worker does,
/// unless `sync_code` is unticked (manual-sync only). Pure, so it is unit-tested.
fn wants_code_fanout(host: &crate::schema::project::ComputeHost) -> bool {
    !host.shared_fs && host.sync_code
}

/// Fan out the current mirror HEAD to **every connected, `sync_code`** worker of a
/// project, emitting a `worker-sync-report` per worker. The commit-trigger and
/// manual "Push code to machines" entry point (plan §2 triggers). Best-effort per
/// worker — one worker failing never blocks the others.
pub async fn fan_out(
    app: &AppHandle,
    pool: &RemotePoolState,
    state: &WorkerSyncState,
    project_id: &str,
    force: bool,
) {
    for host in remote::compute_hosts_for(project_id) {
        if !wants_code_fanout(&host) {
            continue;
        }
        if !remote::is_connected_host(pool, project_id, &host.id).await {
            continue;
        }
        sync_worker_guarded(app, pool, state, project_id, &host.id, force).await;
    }
}

/// One worker's fan-out with the in-flight lock + event emit. Skips silently if a
/// sync to the same worker is already running.
pub async fn sync_worker_guarded(
    app: &AppHandle,
    pool: &RemotePoolState,
    state: &WorkerSyncState,
    project_id: &str,
    host_id: &str,
    force: bool,
) -> WorkerSyncReport {
    let key = remote::conn_key(project_id, host_id);
    {
        let mut guard = state.lock().await;
        if !guard.in_flight.insert(key.clone()) {
            return WorkerSyncReport {
                project_id: project_id.to_string(),
                host_id: host_id.to_string(),
                head: mirror_head(&mirror_dir(project_id)).map(|sha| short_sha(&sha)),
                ok: true,
                skipped: true,
                error: None,
            };
        }
    }
    let report = sync_worker(pool, project_id, host_id, force).await;
    {
        let mut guard = state.lock().await;
        guard.in_flight.remove(&key);
    }
    let _ = app.emit("worker-sync-report", &report);
    report
}

// ── Output pull-back (§4.4) — the ONLY worker→local byte path, user-initiated ──

/// One untracked worker file (an experiment output): its byte size + repo-relative
/// path. Parsed from the worker-side `ls-files --others` listing.
#[derive(Clone, Serialize)]
pub struct WorkerOutput {
    pub rel: String,
    pub bytes: u64,
}

/// A size preview of what a "Pull outputs" would fetch (plan §4.4 size-confirm): a
/// worker's untracked (output) files never touched by the code sync.
#[derive(Clone, Serialize)]
pub struct WorkerOutputsPreview {
    pub files: usize,
    pub bytes: u64,
}

/// The result of a completed output pull: how many files landed, total bytes, the
/// local destination folder, and any per-file errors (best-effort).
#[derive(Clone, Serialize)]
pub struct WorkerPullReport {
    pub pulled: usize,
    pub bytes: u64,
    pub dest: String,
    pub errors: Vec<String>,
}

/// The constant worker-side script listing untracked (output) files with sizes:
/// `<bytes>\t<relpath>` per line. `git clean` is never run — this only *reads*.
/// (A path containing a newline would split; experiment outputs effectively never
/// do, and the tradeoff buys a one-round-trip listing.)
fn outputs_list_script() -> &'static str {
    "git -c core.quotepath=false ls-files --others --exclude-standard | while IFS= read -r f; do \
       sz=$(wc -c < \"$f\" 2>/dev/null || printf 0); \
       printf '%s\\t%s\\n' \"$sz\" \"$f\"; \
     done"
}

/// Parse the `<bytes>\t<relpath>` listing into [`WorkerOutput`]s. Pure. Skips
/// blank/malformed lines and anything with a `..` segment or an absolute path (a
/// download-target traversal guard).
pub fn parse_outputs_listing(stdout: &str) -> Vec<WorkerOutput> {
    stdout
        .lines()
        .filter_map(|line| {
            let (size, rel) = line.split_once('\t')?;
            let rel = rel.trim_end_matches('\r');
            if rel.is_empty() || rel.starts_with('/') {
                return None;
            }
            if rel.split(['/', '\\']).any(|seg| seg == "..") {
                return None;
            }
            let bytes: u64 = size.trim().parse().ok()?;
            Some(WorkerOutput {
                rel: rel.to_string(),
                bytes,
            })
        })
        .collect()
}

/// The local folder a worker's pulled outputs land in: `outputs/<label>/` under the
/// project's state slot. Deliberately NOT inside the git mirror (untracked bytes
/// there would fall to byte-sync and could reach the primary).
fn outputs_dest(project_id: &str, label: &str) -> PathBuf {
    let safe: String = label
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let safe = if safe.trim_matches('-').is_empty() {
        "worker".to_string()
    } else {
        safe
    };
    storage::state_dir()
        .join("remote-projects")
        .join(project_id)
        .join("outputs")
        .join(safe)
}

/// List a worker's untracked output files (blocking ssh).
async fn list_outputs(
    spec: &crate::schema::project::RemoteSpec,
) -> Result<Vec<WorkerOutput>, String> {
    let spec = spec.clone();
    let out = tauri::async_runtime::spawn_blocking(move || {
        ssh_exec::run_remote_script(&spec, outputs_list_script())
    })
    .await
    .map_err(|e| e.to_string())??;
    if !out.status.success() {
        return Err(format!(
            "listing worker outputs failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(parse_outputs_listing(&String::from_utf8_lossy(&out.stdout)))
}

/// Preview the size of a worker's pullable outputs (plan §4.4 size-confirm).
pub async fn preview_outputs(
    project_id: &str,
    host_id: &str,
) -> Result<WorkerOutputsPreview, String> {
    let target = remote::remote_target_for_host(project_id, host_id)
        .ok_or_else(|| "unknown worker host".to_string())?;
    let files = list_outputs(&target.spec).await?;
    Ok(WorkerOutputsPreview {
        files: files.len(),
        bytes: files.iter().map(|f| f.bytes).sum(),
    })
}

/// Pull a worker's untracked outputs into `outputs/<label>/` (plan §4.4). The one
/// place worker→local bytes ever move, and only on this explicit call. Best-effort
/// per file — one download failing never aborts the rest.
pub async fn pull_outputs(
    pool: &RemotePoolState,
    project_id: &str,
    host_id: &str,
) -> Result<WorkerPullReport, String> {
    let target = remote::remote_target_for_host(project_id, host_id)
        .ok_or_else(|| "unknown worker host".to_string())?;
    let spec = target.spec;
    let label = remote::compute_hosts_for(project_id)
        .into_iter()
        .find(|h| h.id == host_id)
        .map(|h| h.display_label().to_string())
        .unwrap_or_else(|| host_id.to_string());

    let files = list_outputs(&spec).await?;
    let dest = outputs_dest(project_id, &label);
    let _ = std::fs::create_dir_all(&dest);

    let sftp = remote::pooled_sftp_host(pool, project_id, host_id)
        .await
        .ok_or_else(|| "worker not connected".to_string())?;
    let root = spec.remote_path.trim_end_matches('/');

    let mut pulled = 0usize;
    let mut bytes = 0u64;
    let mut errors = Vec::new();
    for f in &files {
        let remote_path = format!("{root}/{}", f.rel);
        let local_path = dest.join(&f.rel);
        match sftp::download_file_streaming_on(&sftp, &remote_path, &local_path).await {
            Ok(()) => {
                pulled += 1;
                bytes += f.bytes;
            }
            Err(e) => errors.push(format!("{}: {e}", f.rel)),
        }
    }
    Ok(WorkerPullReport {
        pulled,
        bytes,
        dest: dest.to_string_lossy().into_owned(),
        errors,
    })
}

/// Kicked by `remote_connect` when a **worker** host connects: bring its tracked
/// tree up to the current HEAD. Fire-and-forget from the connect path.
pub async fn on_worker_connect(
    app: AppHandle,
    pool: RemotePoolState,
    state: WorkerSyncState,
    project_id: &str,
    host_id: &str,
) {
    sync_worker_guarded(&app, &pool, &state, project_id, host_id, false).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_apply_script_never_cleans_and_resets_tracked() {
        let s = worker_apply_script();
        // The single load-bearing invariant (plan §8): the worker sync must NEVER
        // `git clean` — that is what lets untracked experiment outputs survive.
        assert!(
            !s.contains("clean"),
            "worker script must never git clean: {s}"
        );
        // It moves the TRACKED tree via reset --hard to the fetched HEAD.
        assert!(s.contains("reset -q --hard FETCH_HEAD"));
        assert!(s.contains("git fetch"));
        assert!(s.contains("git init"));
        // The bundle is a relative name (the script runs `cd <remote_path> && …`).
        assert!(s.contains(WORKER_BUNDLE));
        assert!(!WORKER_BUNDLE.starts_with('/'));
    }

    #[test]
    fn parse_outputs_listing_skips_traversal_and_bad_lines() {
        let stdout = "1024\tcheckpoints/model.bin\n\
                      0\tlogs/run.log\n\
                      \n\
                      512\t../escape.txt\n\
                      99\t/abs/path\n\
                      notanumber\tfoo\n\
                      2048\tnested/dir/weights.pt\r";
        let out = parse_outputs_listing(stdout);
        let rels: Vec<&str> = out.iter().map(|o| o.rel.as_str()).collect();
        assert_eq!(
            rels,
            [
                "checkpoints/model.bin",
                "logs/run.log",
                "nested/dir/weights.pt"
            ]
        );
        assert_eq!(out[0].bytes, 1024);
        assert_eq!(out[2].bytes, 2048); // trailing \r stripped from the path
    }

    #[test]
    fn output_listing_disables_git_path_quoting_and_uses_portable_size() {
        let script = outputs_list_script();
        assert!(script.contains("-c core.quotepath=false"));
        assert!(script.contains("wc -c"));
        assert!(!script.contains("stat -c"));

        let out = parse_outputs_listing("7\tergebnisse-übersicht.csv\n");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].rel, "ergebnisse-übersicht.csv");
        assert_eq!(out[0].bytes, 7);
    }

    #[test]
    fn outputs_dest_sanitizes_label() {
        let p = outputs_dest("proj1", "gpu-2/../etc");
        // No traversal (or path separator) survives the label sanitizer, so the
        // dest can never climb out of the project's outputs folder.
        let s = p.to_string_lossy();
        assert!(!s.contains(".."));
        assert!(s.ends_with("gpu-2----etc"));
        // An all-junk label falls back to "worker" rather than an empty segment.
        assert!(outputs_dest("p", "///")
            .to_string_lossy()
            .ends_with("worker"));
    }

    #[test]
    fn shared_fs_worker_is_never_fanned_out() {
        use crate::schema::project::{ComputeHost, RemoteSpec};
        let mk = |shared_fs: bool, sync_code: bool| ComputeHost {
            id: "h1".into(),
            sync_code,
            pull_outputs: false,
            shared_fs,
            spec: RemoteSpec {
                user: None,
                host: "gpu-2".into(),
                port: None,
                remote_path: "/home/me/project".into(),
                openvpn: None,
                auto_connect: None,
                key_auth: None,
                persist_sessions: None,
                vm: None,
                label: None,
                extra: Default::default(),
            },
        };
        // A shared-filesystem host is NEVER synced — the load-bearing guard that
        // keeps git off the primary's real working tree — regardless of sync_code.
        assert!(!wants_code_fanout(&mk(true, true)));
        assert!(!wants_code_fanout(&mk(true, false)));
        // A synced-copy host is synced iff sync_code is on.
        assert!(wants_code_fanout(&mk(false, true)));
        assert!(!wants_code_fanout(&mk(false, false)));
    }

    #[test]
    fn short_sha_truncates() {
        assert_eq!(short_sha("0123456789abcdef"), "0123456");
        assert_eq!(short_sha("abc"), "abc");
    }

    #[test]
    fn build_bundle_makes_incremental_and_survives_untracked() {
        // Drive a real mirror repo (like examples/lockstep_drv.rs): a commit, an
        // untracked output file, then a bundle of HEAD. This proves `build_bundle`
        // reports a non-empty bundle and that the untracked file is irrelevant to it
        // (git bundle carries objects + HEAD only, never the worktree's untracked
        // bytes — the read half of the "outputs survive" guarantee).
        let tmp = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-ws-{}"), std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let git = |args: &[&str]| Peer::Local(tmp.clone()).run(args).unwrap();
        assert!(git(&["init", "-q"]).status.success());
        let _ = git(&["config", "user.email", "t@e"]);
        let _ = git(&["config", "user.name", "t"]);
        std::fs::write(tmp.join("code.txt"), b"v1").unwrap();
        let added = git(&["add", "code.txt"]);
        assert!(added.status.success(), "{}", String::from_utf8_lossy(&added.stderr));
        assert!(git(&["commit", "-q", "-m", "c1"]).status.success());
        // An untracked experiment output — must never appear in the bundle.
        std::fs::write(tmp.join("checkpoint.bin"), b"weights").unwrap();

        let head = mirror_head(&tmp).expect("committed HEAD");
        assert!(!head.is_empty());
        let bundle = tmp.join("out.bundle");
        let empty = build_bundle(&tmp, &bundle, None).expect("bundle builds");
        assert!(!empty, "a fresh commit is not an empty bundle");
        assert!(bundle.exists());
        // A re-bundle excluding HEAD itself is empty ("nothing new to send").
        let empty2 = build_bundle(&tmp, &tmp.join("out2.bundle"), Some(&head)).expect("ok");
        assert!(
            empty2,
            "excluding HEAD yields an empty (already-synced) bundle"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }
}

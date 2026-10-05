//! Tauri command surface for project VMs (`docs/vm_projects_plan.md`) — thin
//! wrappers over `services::vm` / `services::vm_proxy`, each blocking piece
//! offloaded to `spawn_blocking` (a boot is seconds; a doctor probe is a few
//! process spawns; neither may sit on the main thread — this repo has paid for
//! that freeze before, see `docs/context/git_sync.md`).
//!
//! Also home to the "Download to…" per-file/folder SFTP exit: the mirrorless
//! default posture means the existing tree-transfer buttons (which assume a
//! mirror destination) don't apply, so getting a file out of the VM casually
//! needs its own explicit, size-confirmed, user-clicked channel.

use std::path::{Path, PathBuf};

use openssh_sftp_client::Sftp;
use serde::Serialize;
use tauri::State;

use crate::schema::project::{VmEgress, VmSpec};
use crate::schema::projects::ProjectsList;
use crate::services::remote::RemotePoolState;
use crate::services::sftp;
use crate::services::{vm, vm_proxy};
use crate::storage;

/// `vm_status`'s answer: what the pill glyph + VM settings menu render from.
#[derive(Debug, Clone, Serialize)]
pub struct VmStatus {
    /// The project carries a VM spec at all.
    pub configured: bool,
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub egress: Option<VmEgress>,
    /// Denied CONNECTs (Proxy egress): the exfiltration tripwire.
    pub blocked: vm_proxy::BlockedReport,
}

#[tauri::command]
pub async fn vm_doctor() -> Result<vm::VmDoctorReport, String> {
    tauri::async_runtime::spawn_blocking(vm::doctor)
        .await
        .map_err(|e| e.to_string())
}

/// `async` + blocking pool rather than a plain synchronous command, which would
/// run on the main (GTK) thread: it parses `projects.json` and reads the VM
/// registry, and every VM project's pill polls it every few seconds.
#[tauri::command]
pub async fn vm_status(project_id: String) -> Result<VmStatus, String> {
    tauri::async_runtime::spawn_blocking(move || vm_status_blocking(&project_id))
        .await
        .map_err(|e| e.to_string())
}

fn vm_status_blocking(project_id: &str) -> VmStatus {
    let spec = vm::vm_spec_for(project_id);
    let running = vm::running_state(project_id);
    VmStatus {
        configured: spec.is_some(),
        running: running.is_some(),
        ssh_port: running.as_ref().map(|r| r.ssh_port),
        egress: spec.map(|s| s.egress),
        blocked: vm_proxy::blocked_report(project_id),
    }
}

/// Boot the project's VM (idempotent) and wait for SSH readiness. On success
/// the project's `RemoteSpec` already points at the fresh forwarded port, so
/// the caller can `remote_connect` immediately. (Activation goes through
/// `remote_connect` directly, which boots on its own — this command is the
/// explicit "boot it" action for the pill.)
#[tauri::command]
pub async fn vm_boot(project_id: String) -> Result<vm::VmRuntime, String> {
    let name = project_name(&project_id).unwrap_or_else(|| "project".to_string());
    tauri::async_runtime::spawn_blocking(move || vm::ensure_booted(&project_id, &name))
        .await
        .map_err(|e| e.to_string())?
}

/// Shut the project's VM down (disconnecting the pooled session first is the
/// caller's job — `stores/projects` already disconnects on deactivate).
#[tauri::command]
pub async fn vm_shutdown(project_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || vm::shutdown(&project_id))
        .await
        .map_err(|e| e.to_string())
}

/// Recreate the overlay from the base image. Refused while running; the
/// frontend owns the confirm ("in-VM uncommitted work dies; what was pushed —
/// or pulled to an opted-in mirror — survives").
#[tauri::command]
pub async fn vm_rebuild(project_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || vm::rebuild(&project_id))
        .await
        .map_err(|e| e.to_string())?
}

/// The blocked-connections log (Proxy egress) for the pill / settings dialog.
#[tauri::command]
pub fn vm_blocked(project_id: String) -> vm_proxy::BlockedReport {
    vm_proxy::blocked_report(&project_id)
}

/// Temporarily allow one host through the egress proxy (15 min) — the
/// clone-at-creation channel: the git host is admitted for the initial clone
/// without becoming a standing hole.
#[tauri::command]
pub fn vm_allow_temporarily(project_id: String, host: String) -> Result<(), String> {
    let host = host.trim();
    if host.is_empty() || host.contains('/') || host.contains(':') {
        return Err("not a bare hostname".to_string());
    }
    // The flag guards the knob: a temporary hole is still a hole, and a mail
    // reader's one sanctioned way out is a draft the user sends.
    if vm::vm_spec_for(&project_id).is_some_and(|s| s.mail_reader) {
        return Err("this project is a mail reader; turn \"mail reader\" off before allowing another host".to_string());
    }
    vm_proxy::allow_temporarily(&project_id, host, std::time::Duration::from_secs(15 * 60));
    Ok(())
}

fn has_mirror(project_id: &str) -> bool {
    std::fs::read_dir(crate::services::remote_sync::mirror_dir(project_id))
        .is_ok_and(|mut entries| entries.next().is_some())
}

/// Why this reader's box may not be served mail right now, gathered from the
/// live registry and proxy per call (`services::mail_reader::refusal`). The
/// spec is the trusted `projects.json` copy, which an in-VM agent cannot write.
pub fn mail_reader_refusal(project_id: Option<&str>) -> Option<String> {
    let Some(id) = project_id else {
        return Some("this project is not a mail reader".to_string());
    };
    let live = vm_proxy::live_state(id);
    crate::services::mail_reader::refusal(&crate::services::mail_reader::BoxFacts {
        spec: vm::vm_spec_for(id),
        booted_egress: vm::running_state(id).map(|rt| rt.egress),
        live_temp_allows: live.as_ref().map_or(0, |(_, temp)| *temp),
        live_allow: live.map(|(allow, _)| allow),
        mirror: has_mirror(id),
    })
}

/// Save the VM knobs (memory/cpus/egress/allowlist). Mirrors
/// `set_project_sandbox_spec`'s shape: written to both `projects.json` (the
/// trusted copy) and `project.json` (display/export). Resource changes apply
/// on the next boot; the proxy allowlist applies live.
#[tauri::command]
pub fn vm_set_spec(project_id: String, mut spec: VmSpec) -> Result<VmSpec, String> {
    spec.enabled = true; // the tier is chosen at creation; no in-place disable
    spec.memory_mb = spec.memory_mb.clamp(512, 262_144);
    spec.cpus = spec.cpus.clamp(1, 64);
    spec.disk_gb = spec.disk_gb.clamp(4, 2048);
    spec.allow_hosts = spec
        .allow_hosts
        .iter()
        .map(|h| h.trim().trim_end_matches('.').to_ascii_lowercase())
        .filter(|h| {
            !h.is_empty()
                && !h.contains('/')
                && !h.contains(':')
                && !h.contains(char::is_whitespace)
        })
        .collect();
    if let Some(refusal) = crate::services::mail_reader::widen_refusal(&spec, has_mirror(&project_id)) {
        return Err(refusal);
    }

    crate::commands::projects::patch_project_entry_mirrored(
        &project_id,
        |entry| {
            // The tiers are exclusive — a VM project must never also enable the
            // Docker sandbox (`set_project_sandbox` refuses the reverse direction).
            let sandboxed = entry
                .extra
                .get("sandbox")
                .and_then(|v| v.get("enabled"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if sandboxed {
                return Err(
                    "This project has the Docker container enabled; the VM and container tiers are exclusive."
                        .to_string(),
                );
            }
            entry.extra.insert(
                "vm".to_string(),
                serde_json::to_value(&spec).map_err(|e| e.to_string())?,
            );
            Ok(())
        },
        |project, ()| project.vm = Some(spec.clone()),
    )?;

    // A live proxy picks the new allowlist up immediately; egress-mode changes
    // (netdev + guest env) need the next boot and the UI says so.
    if matches!(spec.egress, VmEgress::Proxy) {
        vm_proxy::set_allowlist(
            &project_id,
            vm_proxy::allowlist_for(&spec.allow_hosts, spec.allow_github),
        );
    }
    Ok(spec)
}

/// Commits inside the VM that no remote (and no mirror) has — the "the overlay
/// is the only copy" surfacing for mirrorless projects. `None` when the VM is
/// down, the tree isn't a repo yet, or the count could not be read (never 0
/// for "couldn't tell").
#[tauri::command]
pub async fn vm_unpushed_commits(project_id: String) -> Result<Option<u64>, String> {
    if !vm::is_running(&project_id) {
        return Ok(None);
    }
    let Some(target) = crate::services::remote::remote_target_for(&project_id) else {
        return Ok(None);
    };
    let count = tauri::async_runtime::spawn_blocking(move || {
        crate::services::ssh_exec::run_remote_script(
            &target.spec,
            "git rev-list --count --branches --not --remotes 2>/dev/null || true",
        )
    })
    .await
    .map_err(|e| e.to_string())??;
    let text = String::from_utf8_lossy(&count.stdout);
    Ok(text.trim().parse::<u64>().ok())
}

pub(crate) fn project_name(project_id: &str) -> Option<String> {
    let list_path = storage::state_dir().join("projects.json");
    let list: ProjectsList = storage::read_json(&list_path).ok()?;
    list.into_iter()
        .find(|e| e.id == project_id)
        .map(|e| e.name)
}

// ── "Download to…" — the mirrorless per-file/folder exit ───────────────────

/// What a download would transfer, for the size-confirm dialog: file count +
/// total bytes (apparent sizes from the SFTP listing).
#[derive(Debug, Clone, Serialize)]
pub struct RemoteTreeSize {
    pub files: u64,
    pub bytes: u64,
}

/// A remote path relative to the project root, kept inside it. Rejects
/// absolute paths and any `..`/empty segment — the remote tree is
/// agent-written, i.e. attacker-controlled, and this is the one boundary
/// check between it and an arbitrary local write location.
fn resolve_remote_rel(root: &str, rel: &str) -> Result<String, String> {
    let rel = rel.trim().trim_matches('/');
    if rel.is_empty() {
        return Ok(root.trim_end_matches('/').to_string());
    }
    for seg in rel.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return Err("invalid remote path".to_string());
        }
    }
    Ok(format!("{}/{}", root.trim_end_matches('/'), rel))
}

/// A local file name a remote entry may create: its final segment, refused
/// rather than sanitized when it is path-ish (the remote side names it, and a
/// name with a separator in it is not a name).
fn safe_local_name(name: &str) -> Result<&str, String> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
    {
        return Err(format!("refusing suspicious remote file name '{name}'"));
    }
    Ok(name)
}

async fn walk_remote_size(sftp: &Sftp, path: &str, depth: u32) -> Result<RemoteTreeSize, String> {
    if depth > 64 {
        return Err("remote tree too deep".to_string());
    }
    let mut total = RemoteTreeSize { files: 0, bytes: 0 };
    for entry in sftp::list_dir_on(sftp, path).await? {
        let child = format!("{}/{}", path.trim_end_matches('/'), entry.name);
        if entry.is_dir {
            let sub = Box::pin(walk_remote_size(sftp, &child, depth + 1)).await?;
            total.files += sub.files;
            total.bytes += sub.bytes;
        } else {
            total.files += 1;
            total.bytes += entry.size;
        }
    }
    Ok(total)
}

/// Size a remote file/folder before downloading it (the confirm dialog's
/// numbers). `rel_path` is project-root-relative; `""` sizes the whole tree.
#[tauri::command]
pub async fn remote_download_size(
    pool: State<'_, RemotePoolState>,
    project_id: String,
    rel_path: String,
) -> Result<RemoteTreeSize, String> {
    let target = crate::services::remote::remote_target_for(&project_id)
        .ok_or_else(|| "not a remote project".to_string())?;
    let path = resolve_remote_rel(&target.spec.remote_path, &rel_path)?;
    let sftp = crate::services::remote::pooled_sftp(pool.inner(), &project_id)
        .await
        .ok_or_else(|| "not connected".to_string())?;
    let (size, _) = sftp::metadata_on(&sftp, &path).await?;
    // A file stats directly; a dir walks. `metadata_on` has no is_dir, so try
    // the listing first and fall back to the file stat.
    match walk_remote_size(&sftp, &path, 0).await {
        Ok(tree) => Ok(tree),
        Err(_) => Ok(RemoteTreeSize {
            files: 1,
            bytes: size,
        }),
    }
}

async fn download_tree(sftp: &Sftp, remote: &str, dest: &Path, depth: u32) -> Result<u64, String> {
    if depth > 64 {
        return Err("remote tree too deep".to_string());
    }
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let mut copied = 0u64;
    for entry in sftp::list_dir_on(sftp, remote).await? {
        let name = safe_local_name(&entry.name)?;
        let child_remote = format!("{}/{}", remote.trim_end_matches('/'), name);
        let child_dest = dest.join(name);
        if entry.is_dir {
            copied += Box::pin(download_tree(sftp, &child_remote, &child_dest, depth + 1)).await?;
        } else {
            sftp::download_file_streaming_on(sftp, &child_remote, &child_dest).await?;
            copied += 1;
        }
    }
    Ok(copied)
}

/// "Download to…": copy a project-root-relative remote file/folder to a local
/// destination directory the user picked in a dialog. Every crossing is
/// user-clicked; the agent can stage bytes but cannot trigger this. Returns
/// the number of files copied.
#[tauri::command]
pub async fn remote_download_to(
    pool: State<'_, RemotePoolState>,
    project_id: String,
    rel_path: String,
    dest_dir: String,
) -> Result<u64, String> {
    let target = crate::services::remote::remote_target_for(&project_id)
        .ok_or_else(|| "not a remote project".to_string())?;
    let remote = resolve_remote_rel(&target.spec.remote_path, &rel_path)?;
    let dest_dir = PathBuf::from(dest_dir.trim());
    if !dest_dir.is_absolute() || !dest_dir.is_dir() {
        return Err("destination must be an existing local folder".to_string());
    }
    let sftp = crate::services::remote::pooled_sftp(pool.inner(), &project_id)
        .await
        .ok_or_else(|| "not connected".to_string())?;

    // Leaf name: the picked entry's own name (or the project name for "").
    let leaf = remote
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("download")
        .to_string();
    let leaf = safe_local_name(&leaf)?.to_string();

    // Dir vs file: a listable path downloads as a tree, else as one file.
    match sftp::list_dir_on(&sftp, &remote).await {
        Ok(_) => download_tree(&sftp, &remote, &dest_dir.join(&leaf), 0).await,
        Err(_) => {
            sftp::download_file_streaming_on(&sftp, &remote, &dest_dir.join(&leaf)).await?;
            Ok(1)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_rel_stays_inside_the_root() {
        assert_eq!(
            resolve_remote_rel(concat!("/home/", crate::app_slug!(), "/project/"), "src/main.rs").unwrap(),
            concat!("/home/", crate::app_slug!(), "/project/src/main.rs")
        );
        assert_eq!(
            resolve_remote_rel(concat!("/home/", crate::app_slug!(), "/project"), "").unwrap(),
            concat!("/home/", crate::app_slug!(), "/project")
        );
        assert!(resolve_remote_rel("/root", "../etc/passwd").is_err());
        assert!(resolve_remote_rel("/root", "a//b").is_err());
        assert!(resolve_remote_rel("/root", "a/./b").is_err());
    }

    #[test]
    fn remote_file_names_with_separators_are_refused() {
        assert!(safe_local_name("notes.md").is_ok());
        assert!(safe_local_name("..").is_err());
        assert!(safe_local_name("a/b").is_err());
        assert!(safe_local_name("a\\b").is_err());
        assert!(safe_local_name("").is_err());
    }
}

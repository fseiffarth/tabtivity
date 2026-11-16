//! Remote buffers use a local, empty workspace. Only authorized editor text is
//! synchronized: no SSH credentials or remote filesystem mounts reach CLS.
use std::path::{Path, PathBuf};
use crate::schema::Settings;
use crate::services::{remote, remote_sync};
use super::policy::{self, PolicyError};

pub fn binding(target: &remote::RemoteTarget) -> String {
    serde_json::json!([
        target.spec.host, target.spec.user, target.spec.port.unwrap_or(22),
        target.spec.remote_path, mirror(&target.project_id),
    ]).to_string()
}

fn mirror(project_id: &str) -> Option<PathBuf> {
    remote_sync::mirror_dir_opt(project_id)?.canonicalize().ok()
}

/// An identity change selects a different server as well as requiring consent.
pub fn workspace(binding: &str, directory: &str) -> PathBuf {
    use sha2::{Digest, Sha256};
    let key = serde_json::json!([binding, directory]).to_string();
    crate::storage::state_dir().join("copilot").join("remote-workspaces")
        .join(format!("{:x}", Sha256::digest(key.as_bytes())))
}

pub fn authorize(settings: &Settings, target: &remote::RemoteTarget) -> Result<PathBuf, PolicyError> {
    if settings.code_completion_provider.as_deref() != Some("copilot") || !settings.copilot_completion() {
        return Err(PolicyError::Disabled);
    }
    let policy = settings.completion_project_policies.as_ref()
        .and_then(|policies| policies.get(&target.project_id)).ok_or(PolicyError::NoConsent)?;
    if policy.local_only { return Err(PolicyError::LocalOnly); }
    let binding = binding(target);
    if !policy.copilot || policy.remote.as_deref() != Some(&binding) || !absolute(&policy.directory) {
        return Err(PolicyError::NoConsent);
    }
    Ok(workspace(&binding, &policy.directory))
}

fn absolute(path: &str) -> bool {
    path.starts_with('/') && !path.contains(['\\', '\0'])
        && !path.split('/').any(|part| matches!(part, "." | ".."))
}

/// POSIX paths on every desktop OS; never interpret a host path as Windows.
fn relative<'a>(root: &str, file: &'a str) -> Result<&'a str, String> {
    if !absolute(root) || !absolute(file) { return Err("copilot_invalid_path".into()); }
    file.strip_prefix(root.trim_end_matches('/')).and_then(|s| s.strip_prefix('/'))
        .filter(|s| !s.is_empty() && !s.starts_with('/')).ok_or_else(|| "copilot_outside_project".into())
}

fn checked_file<'a>(root: &str, opened: &str, resolved: &'a str, regular: bool, text: bool) -> Result<&'a str, String> {
    let rel = relative(root, resolved)?;
    if policy::secret_shaped(Path::new(opened)) || policy::secret_shaped(Path::new(resolved)) {
        return Err("copilot_secret_file".into());
    }
    if !regular { return Err("copilot_invalid_path".into()); }
    if (policy::text_file(Path::new(opened)) || policy::text_file(Path::new(resolved))) && !text {
        return Err("copilot_code_only".into());
    }
    Ok(rel)
}

pub async fn canonical_root(pool: &remote::RemotePoolState, target: &remote::RemoteTarget) -> Result<String, String> {
    let sftp = remote::pooled_sftp_for_target(pool, target).await.ok_or("copilot_remote_disconnected")?;
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let mut fs = sftp.fs();
        let root = fs.canonicalize(&target.spec.remote_path).await.map_err(|_| "copilot_invalid_path")?;
        let root = root.to_str().ok_or("copilot_invalid_path")?.to_owned();
        if !absolute(&root) || !fs.metadata(&root).await.map_err(|_| "copilot_invalid_path")?
            .file_type().is_some_and(|kind| kind.is_dir()) {
            return Err("copilot_invalid_path".into());
        }
        Ok(root)
    }).await.map_err(|_| "copilot_remote_disconnected")?
}

/// Both the opened name and SFTP-resolved name must remain inside the
/// consented root and outside credential files. Missing/non-regular files fail.
pub async fn document(
    pool: &remote::RemotePoolState, settings: &Settings, target: &remote::RemoteTarget,
    workspace: &Path, path: &str,
) -> Result<PathBuf, String> {
    let policy = settings.completion_project_policies.as_ref()
        .and_then(|policies| policies.get(&target.project_id)).ok_or("copilot_no_consent")?;
    // A remote project's Local tree is still a local file, confined to its
    // own mirror. It gets a separate URI namespace from the host tree.
    if remote_sync::is_under_mirror(&target.project_id, path) {
        let mirror = mirror(&target.project_id).ok_or("copilot_outside_project")?;
        let file = policy::authorize_document(&mirror, Path::new(path)).map_err(policy::error_code)?;
        if crate::services::agent_privacy::inside_locked(&file) { return Err("copilot_local_only".into()); }
        if policy::text_file(&file) && !policy.copilot_text { return Err("copilot_code_only".into()); }
        return Ok(workspace.join("local").join(file.strip_prefix(&mirror).map_err(|_| "copilot_invalid_path")?));
    }
    relative(&target.spec.remote_path, path)?;
    if policy::secret_shaped(Path::new(path)) { return Err("copilot_secret_file".into()); }
    let sftp = remote::pooled_sftp_for_target(pool, target).await.ok_or("copilot_remote_disconnected")?;
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let mut fs = sftp.fs();
        let root = fs.canonicalize(&target.spec.remote_path).await.map_err(|_| "copilot_invalid_path")?;
        if root.to_str() != Some(policy.directory.as_str()) { return Err("copilot_no_consent".into()); }
        let file = fs.canonicalize(path).await.map_err(|_| "copilot_invalid_path")?;
        let file = file.to_str().ok_or("copilot_invalid_path")?;
        let regular = fs.metadata(file).await.map_err(|_| "copilot_invalid_path")?
            .file_type().is_some_and(|kind| kind.is_file());
        let rel = checked_file(&policy.directory, path, file, regular, policy.copilot_text)?;
        // A nested local-models-only project on this host stays private even
        // when reached through another project's consent or a symlink.
        let projects = remote::projects().map_err(|_| "copilot_local_only")?;
        for entry in projects.iter().filter(|entry| crate::services::agent_privacy::is_locked(entry)) {
            let Some(spec) = remote::spec_from_entry(entry) else { continue; };
            if spec.host != target.spec.host || spec.user != target.spec.user
                || spec.port.unwrap_or(22) != target.spec.port.unwrap_or(22) { continue; }
            let locked = fs.canonicalize(&spec.remote_path).await.map_err(|_| "copilot_local_only")?;
            let locked = locked.to_str().ok_or("copilot_local_only")?;
            if file == locked || relative(locked, file).is_ok() { return Err("copilot_local_only".into()); }
        }
        Ok(workspace.join("remote").join(rel))
    }).await.map_err(|_| "copilot_remote_disconnected")?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> remote::RemoteTarget {
        remote::RemoteTarget {
            project_id: "copilot-remote-test".into(),
            spec: serde_json::from_value(serde_json::json!({
                "host": "example.invalid", "user": "test", "remote_path": "/srv/project"
            })).unwrap(),
        }
    }

    #[test]
    fn consent_is_bound_to_endpoint_root_and_project_and_round_trips() {
        let target = target();
        let mut settings: Settings = serde_json::from_value(serde_json::json!({
            "code_completion_provider": "copilot", "copilot_completion": true,
            "completion_project_policies": {"copilot-remote-test": {
                "directory": "/real/project", "copilot": true, "remote": binding(&target),
                "future_field": 17
            }}
        })).unwrap();
        let expected = workspace(&binding(&target), "/real/project");
        assert_eq!(authorize(&settings, &target), Ok(expected.clone()));
        let restored: Settings = serde_json::from_value(serde_json::to_value(&settings).unwrap()).unwrap();
        assert_eq!(authorize(&restored, &target), Ok(expected.clone()));
        assert_eq!(restored.completion_project_policies.as_ref().unwrap()[&target.project_id].extra["future_field"], 17);
        for field in ["host", "user", "port", "remote_path", "project_id"] {
            let mut changed = target.clone();
            match field {
                "host" => changed.spec.host = "other.invalid".into(),
                "user" => changed.spec.user = Some("other".into()),
                "port" => changed.spec.port = Some(2222),
                "remote_path" => changed.spec.remote_path = "/elsewhere".into(),
                _ => changed.project_id = "another-project".into(),
            }
            assert_eq!(authorize(&settings, &changed), Err(PolicyError::NoConsent), "{field}");
        }
        let policy = settings.completion_project_policies.as_mut().unwrap().get_mut(&target.project_id).unwrap();
        policy.remote = None;
        assert_eq!(authorize(&settings, &target), Err(PolicyError::NoConsent));
        let policy = settings.completion_project_policies.as_mut().unwrap().get_mut(&target.project_id).unwrap();
        policy.remote = Some(binding(&target));
        policy.local_only = true;
        assert_eq!(authorize(&settings, &target), Err(PolicyError::LocalOnly));
        settings.copilot_completion = Some(false);
        assert_eq!(authorize(&settings, &target), Err(PolicyError::Disabled));
        assert_ne!(workspace(&binding(&target), "/different"), expected);
    }

    #[test]
    fn symlink_targets_secrets_text_and_non_regular_files_are_rejected() {
        let root = "/srv/project";
        assert_eq!(checked_file(root, "/srv/project/a.ts", "/srv/project/code/a.ts", true, false).unwrap(), "code/a.ts");
        assert!(checked_file(root, "/srv/project/a.ts", "/outside/a.ts", true, true).is_err());
        for (opened, resolved) in [
            ("/srv/project/.env", "/srv/project/code.ts"),
            ("/srv/project/code.ts", "/srv/project/.env"),
            ("/srv/project/code.ts", "/srv/project/id_ed25519"),
            ("/srv/project/code.ts", "/srv/project/server.KEY"),
        ] {
            assert_eq!(checked_file(root, opened, resolved, true, true).unwrap_err(), "copilot_secret_file");
        }
        assert_eq!(checked_file(root, "/srv/project/a.ts", "/srv/project/a.ts", false, true).unwrap_err(), "copilot_invalid_path");
        assert_eq!(checked_file(root, "/srv/project/notes.md", "/srv/project/code.ts", true, false).unwrap_err(), "copilot_code_only");
        assert_eq!(checked_file(root, "/srv/project/code.ts", "/srv/project/notes.md", true, false).unwrap_err(), "copilot_code_only");
        assert!(checked_file(root, "/srv/project/notes.md", "/srv/project/notes.md", true, true).is_ok());
    }

    #[tokio::test]
    async fn disconnected_projects_never_open_a_new_connection() {
        assert_eq!(canonical_root(&remote::new_pool(), &target()).await.unwrap_err(), "copilot_remote_disconnected");
    }

    #[test]
    fn remote_paths_are_posix_confined_on_every_os() {
        assert_eq!(relative("/srv/project", "/srv/project/code/a.ts").unwrap(), "code/a.ts");
        assert_eq!(relative("/", "/code/a.ts").unwrap(), "code/a.ts");
        for path in ["/srv/project-evil/a.ts", "/srv/project/../secret", "/srv/project/./a.ts", "relative", "/srv/project/a\\b", "/srv/project"] {
            assert!(relative("/srv/project", path).is_err(), "{path}");
        }
    }
}

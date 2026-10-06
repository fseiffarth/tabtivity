//! Context authorization happens before document text reaches a subprocess.
use crate::schema::Settings;
use std::path::{Path, PathBuf};

#[derive(Debug, PartialEq, Eq)]
pub enum PolicyError {
    Disabled,
    Remote,
    NoConsent,
    LocalOnly,
    InvalidPath,
    OutsideProject,
    SecretFile,
}

/// `directory` and `remote` must come from the backend project resolver, not
/// the command's payload or the file's apparent path. Recheck on every sync.
pub fn authorize_project(
    settings: &Settings,
    project_id: &str,
    directory: &Path,
    remote: bool,
) -> Result<PathBuf, PolicyError> {
    if settings.code_completion_provider.as_deref() != Some("copilot")
        || !settings
            .copilot_completion
            .unwrap_or(settings.debug.unwrap_or(false))
    {
        return Err(PolicyError::Disabled);
    }
    if remote {
        return Err(PolicyError::Remote);
    }
    let policy = settings
        .completion_project_policies
        .as_ref()
        .and_then(|policies| policies.get(project_id))
        .ok_or(PolicyError::NoConsent)?;
    if policy.local_only {
        return Err(PolicyError::LocalOnly);
    }
    if !policy.copilot {
        return Err(PolicyError::NoConsent);
    }
    if !directory.is_absolute() {
        return Err(PolicyError::InvalidPath);
    }
    let root = directory
        .canonicalize()
        .map_err(|_| PolicyError::InvalidPath)?;
    // Consent contains the canonical path as it was at opt-in time. Do not
    // canonicalize it again: replacing a consented path with a symlink must
    // require new consent, even when the project id remains the same.
    if Path::new(&policy.directory) != root || !root.is_dir() {
        return Err(PolicyError::NoConsent);
    }
    Ok(root)
}

/// The project's second opt-in: Copilot may also see its text files. Only
/// meaningful once `authorize_project` has passed.
pub fn text_consented(settings: &Settings, project_id: &str) -> bool {
    settings
        .completion_project_policies
        .as_ref()
        .and_then(|policies| policies.get(project_id))
        .is_some_and(|policy| policy.copilot_text)
}

/// Files that hold credentials rather than code or prose. No consent covers
/// them: a project's `.env` or a key file never reaches the cloud.
fn secret_shaped(file: &Path) -> bool {
    let Some(name) = file.file_name().and_then(|name| name.to_str()) else {
        return true;
    };
    let name = name.to_ascii_lowercase();
    let extension = Path::new(&name).extension().and_then(|ext| ext.to_str()).unwrap_or("");
    name == ".env"
        || name.starts_with(".env.")
        || extension == "env"
        || matches!(name.as_str(), ".npmrc" | ".netrc" | ".pgpass" | ".pypirc" | ".git-credentials" | "credentials")
        || ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"].iter().any(|key| name.starts_with(key))
        || matches!(extension, "pem" | "key" | "p12" | "pfx" | "jks" | "keystore")
}

pub fn authorize_document(root: &Path, path: &Path) -> Result<PathBuf, PolicyError> {
    if !path.is_absolute() {
        return Err(PolicyError::InvalidPath);
    }
    let file = path.canonicalize().map_err(|_| PolicyError::InvalidPath)?;
    if !file.starts_with(root) || !file.is_file() {
        return Err(PolicyError::OutsideProject);
    }
    // Both names: a symlink called `notes.txt` must not export `.env`.
    if secret_shaped(path) || secret_shaped(&file) {
        return Err(PolicyError::SecretFile);
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn settings(directory: &Path) -> Settings {
        // Opt-in records the canonical path (macOS /private/var, Windows \\?\).
        let directory = directory.canonicalize().unwrap();
        serde_json::from_value(json!({
            "code_completion_provider":"copilot", "copilot_completion":true,
            "completion_project_policies":{"one":{"directory":directory,"copilot":true}}
        }))
        .unwrap()
    }

    #[test]
    fn missing_settings_keep_ollama_and_require_explicit_consent() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            authorize_project(&Settings::default(), "one", dir.path(), false),
            Err(PolicyError::Disabled)
        );
        let mut config = settings(dir.path());
        assert!(authorize_project(&config, "one", dir.path(), false).is_ok());
        assert_eq!(
            authorize_project(&config, "two", dir.path(), false),
            Err(PolicyError::NoConsent)
        );
        assert_eq!(
            authorize_project(&config, "one", dir.path(), true),
            Err(PolicyError::Remote)
        );
        config
            .completion_project_policies
            .as_mut()
            .unwrap()
            .get_mut("one")
            .unwrap()
            .local_only = true;
        assert_eq!(
            authorize_project(&config, "one", dir.path(), false),
            Err(PolicyError::LocalOnly)
        );
        config.copilot_completion = Some(false);
        config.debug = Some(true);
        assert_eq!(
            authorize_project(&config, "one", dir.path(), false),
            Err(PolicyError::Disabled)
        );
    }

    #[test]
    fn consent_cannot_follow_a_repointed_project() {
        let one = tempfile::tempdir().unwrap();
        let two = tempfile::tempdir().unwrap();
        assert_eq!(
            authorize_project(&settings(one.path()), "one", two.path(), false),
            Err(PolicyError::NoConsent)
        );
        std::fs::write(two.path().join("code.ts"), "synthetic").unwrap();
        assert_eq!(
            authorize_document(one.path(), &two.path().join("code.ts")),
            Err(PolicyError::OutsideProject)
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_cannot_export_another_project() {
        let one = tempfile::tempdir().unwrap();
        let two = tempfile::tempdir().unwrap();
        let file = two.path().join("code.ts");
        std::fs::write(&file, "synthetic").unwrap();
        let link = one.path().join("link.ts");
        std::os::unix::fs::symlink(file, &link).unwrap();
        assert_eq!(
            authorize_document(one.path(), &link),
            Err(PolicyError::OutsideProject)
        );
    }

    #[test]
    fn text_files_need_their_own_consent() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = settings(dir.path());
        assert!(!text_consented(&config, "one"));
        config.completion_project_policies.as_mut().unwrap().get_mut("one").unwrap().copilot_text = true;
        assert!(text_consented(&config, "one"));
        assert!(!text_consented(&config, "two"));
        let raw: Settings = serde_json::from_value(json!({
            "completion_project_policies":{"one":{"directory":"/p","copilot":true,"copilot_text":true}}
        })).unwrap();
        assert!(text_consented(&raw, "one"));
    }

    #[test]
    fn secret_files_never_reach_copilot() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        for name in [".env", ".env.local", "prod.env", ".npmrc", "id_ed25519", "id_rsa.pub", "server.pem", "tls.KEY"] {
            let file = root.join(name);
            std::fs::write(&file, "synthetic").unwrap();
            assert_eq!(authorize_document(&root, &file), Err(PolicyError::SecretFile), "{name}");
        }
        for name in ["notes.txt", "README.md", "paper.tex", "environment.ts", "keys.rs"] {
            let file = root.join(name);
            std::fs::write(&file, "synthetic").unwrap();
            assert_eq!(authorize_document(&root, &file), Ok(file.clone()), "{name}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn symlink_cannot_launder_a_secret_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::write(root.join(".env"), "synthetic").unwrap();
        let link = root.join("notes.txt");
        std::os::unix::fs::symlink(root.join(".env"), &link).unwrap();
        assert_eq!(authorize_document(&root, &link), Err(PolicyError::SecretFile));
    }

    #[test]
    fn settings_preserve_legacy_roles_and_unknown_policy_fields() {
        let value = json!({"ollama_model":"coder", "ollama_roles":{"autocomplete":"code","autocomplete_prose":"prose"},
            "python_setting":[1,2], "completion_project_policies":{"one":{"directory":"/project","copilot":true,"future":42}}});
        let config: Settings = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(config.code_completion_provider, None);
        assert_eq!(config.copilot_completion, None);
        let result = serde_json::to_value(config).unwrap();
        for key in ["ollama_model", "ollama_roles", "python_setting"] {
            assert_eq!(result[key], value[key]);
        }
        assert_eq!(result["completion_project_policies"]["one"]["future"], 42);
        assert!(result.get("code_completion_provider").is_none());
    }
}

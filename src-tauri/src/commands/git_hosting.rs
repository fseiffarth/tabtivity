//! Git-hosting credentials, as the renderer edits them: the host list of
//! Settings → Git Hosting (one default token per host) and the per-project
//! override (profile URL + token) that wins over it.
//!
//! Non-secret profile URLs are persisted in `settings.json` (`git_hosts`) and
//! in the `projects.json` entry (mirrored into the project's `project.json`
//! for display/export only — that file sits in the project tree, where
//! anything working there can rewrite it). Every token lives only in the OS
//! keyring (`services::git_credentials`) and never comes back to the renderer:
//! these commands answer only whether one is stored. Which token a git call
//! uses is `services::git_hosting`.

use serde_json::Value;

use crate::services::git_credentials;
// The credential resolution lives in `services::git_hosting` (S5).
pub use crate::services::git_hosting::{cli_token, project_auth, project_auth_for, token_origins};
use crate::services::git_hosting::{
    configured_hosts, default_profile_url, host_scope, host_token, project_profile_url, url_origin, MAX_HOSTS,
};

/// What the frontend gets back about a project's git hosting. The token itself is
/// never returned — only whether one is stored — so the secret stays out of the
/// renderer.
#[derive(serde::Serialize)]
pub struct GitHostingInfo {
    /// Per-project profile URL override, if any.
    pub profile_url: Option<String>,
    /// Whether a per-project token is stored in the keyring.
    pub has_token: bool,
    /// The default host's profile URL (Settings → Git Hosting), shown as the
    /// placeholder/inherited value in the editor.
    pub global_profile_url: Option<String>,
    /// Whether any host default exists to fall back on.
    pub has_global_token: bool,
}

/// Read effective hosting config for the project-settings editor.
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn get_project_git_hosting(project_id: String) -> Result<GitHostingInfo, String> {
    let profile_url = project_profile_url(&project_id)?;
    let settings = crate::storage::load_settings();
    Ok(GitHostingInfo {
        profile_url,
        has_token: git_credentials::has_token(&project_id),
        global_profile_url: default_profile_url(settings.as_ref()),
        has_global_token: !crate::services::git_hosting::hosts_auth().is_empty(),
    })
}

/// Write the per-project hosting override. `profile_url` is stored in
/// project.json + projects.json (cleared when blank). The token is stored in the
/// keyring when `token` is `Some`; when `clear_token` is true the stored token is
/// removed. A `token` of `None` with `clear_token` false leaves the token as-is
/// (so saving just the URL doesn't wipe an existing secret).
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn set_project_git_hosting(
    project_id: String,
    profile_url: Option<String>,
    token: Option<String>,
    clear_token: bool,
) -> Result<GitHostingInfo, String> {
    let cleaned_url = profile_url
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    // projects.json (always-local source of truth for the pill) + the
    // project.json descriptive/export mirror, in one serialized patch. An
    // unknown id fails here, before any keyring write.
    crate::commands::projects::patch_project_entry_mirrored(
        &project_id,
        |entry| {
            match &cleaned_url {
                Some(url) => {
                    entry
                        .extra
                        .insert("git_profile_url".to_string(), Value::String(url.clone()));
                }
                None => {
                    entry.extra.remove("git_profile_url");
                }
            }
            Ok(())
        },
        |project, ()| project.git_profile_url = cleaned_url.clone(),
    )?;

    // Token → keyring. Only touch it when explicitly provided/cleared.
    if clear_token {
        git_credentials::set_token(&project_id, None)?;
    } else if token.is_some() {
        git_credentials::set_token(&project_id, token.as_deref())?;
    }

    get_project_git_hosting(project_id)
}

/// One row of Settings → Git Hosting.
#[derive(serde::Serialize, Debug, PartialEq, Eq)]
pub struct GitHostEntry {
    pub profile_url: String,
    /// `scheme://host[:port]`: what the token is offered to.
    pub origin: String,
    pub has_token: bool,
}

/// One row as the renderer saves it. `token` set = store it; `clear_token` =
/// remove the stored one; neither = keep whatever is stored.
#[derive(serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitHostEdit {
    pub profile_url: String,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub clear_token: bool,
}

/// The listed hosts, first = default, each with whether a token is stored.
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn get_git_hosts() -> Result<Vec<GitHostEntry>, String> {
    let settings = crate::storage::load_settings();
    Ok(configured_hosts(settings.as_ref())
        .into_iter()
        .filter_map(|profile_url| {
            let origin = url_origin(&profile_url)?;
            let has_token = host_token(&origin).is_some();
            Some(GitHostEntry { profile_url, origin, has_token })
        })
        .collect())
}

/// The rows' origins, refused when one is not an http(s) URL, two name the
/// same host, or there are more than [`MAX_HOSTS`]. Pure.
fn validate_hosts(hosts: &[GitHostEdit]) -> Result<Vec<String>, String> {
    if hosts.len() > MAX_HOSTS {
        return Err(format!("At most {MAX_HOSTS} hosts can be listed."));
    }
    let mut origins: Vec<String> = Vec::new();
    for host in hosts {
        let url = host.profile_url.trim();
        let origin = url_origin(url)
            .ok_or_else(|| format!("'{url}' is not an https:// address."))?;
        if origins.contains(&origin) {
            return Err(format!("{origin} is listed twice; one token per host."));
        }
        origins.push(origin);
    }
    Ok(origins)
}

/// Replace the host list: store or clear each row's token, drop the tokens of
/// hosts no longer listed, then write the list (and its first row as
/// `git_profile_url`, which older builds read). A keyring failure stops
/// before the list is written.
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn set_git_hosts(hosts: Vec<GitHostEdit>) -> Result<Vec<GitHostEntry>, String> {
    let origins = validate_hosts(&hosts)?;
    // An unmigrated plaintext token first, so it lands in the keyring rather
    // than being lost with the row it belonged to. Failing is fine: then the
    // keyring writes below fail too and say so.
    let _ = crate::services::git_hosting::migrate_legacy_token();

    let before: Vec<String> = configured_hosts(crate::storage::load_settings().as_ref())
        .iter()
        .filter_map(|url| url_origin(url))
        .collect();
    for (host, origin) in hosts.iter().zip(&origins) {
        let token = host.token.as_deref().map(str::trim).filter(|t| !t.is_empty());
        if let Some(token) = token {
            git_credentials::set_token(&host_scope(origin), Some(token))?;
        } else if host.clear_token {
            git_credentials::set_token(&host_scope(origin), None)?;
        }
    }
    for gone in before.iter().filter(|o| !origins.contains(o)) {
        git_credentials::set_token(&host_scope(gone), None)?;
    }

    let urls: Vec<String> = hosts.iter().map(|h| h.profile_url.trim().to_string()).collect();
    crate::storage::patch_json(&crate::storage::settings_path(), crate::schema::Settings::default(), |settings| {
        settings.git_profile_url = urls.first().cloned();
        settings.git_hosts = Some(urls.clone());
        settings.rev += 1;
        Ok(())
    })?;
    get_git_hosts()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edit(url: &str) -> GitHostEdit {
        GitHostEdit { profile_url: url.into(), token: None, clear_token: false }
    }

    #[test]
    fn a_host_list_is_one_https_row_per_host() {
        assert_eq!(
            validate_hosts(&[edit("https://github.com/me"), edit(" https://gitlab.example.org/me ")]).unwrap(),
            vec!["https://github.com", "https://gitlab.example.org"]
        );
        assert!(validate_hosts(&[edit("github.com/me")]).is_err(), "no scheme");
        assert!(validate_hosts(&[edit("git@github.com:me/r.git")]).is_err(), "ssh");
        assert!(validate_hosts(&[edit("https://github.com/a"), edit("https://GITHUB.com/b")]).is_err(), "same host twice");
        let many: Vec<GitHostEdit> = (0..=MAX_HOSTS).map(|i| edit(&format!("https://h{i}.example/me"))).collect();
        assert!(validate_hosts(&many).is_err());
    }

    #[test]
    fn a_saved_row_is_camel_case_and_keeps_its_token_unless_told() {
        let row: GitHostEdit = serde_json::from_value(serde_json::json!({"profileUrl": "https://github.com/me"})).unwrap();
        assert_eq!((row.token, row.clear_token), (None, false));
        let row: GitHostEdit =
            serde_json::from_value(serde_json::json!({"profileUrl": "https://github.com/me", "clearToken": true})).unwrap();
        assert!(row.clear_token);
    }
}

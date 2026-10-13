//! Per-project git-hosting overrides (profile URL + access token) that take
//! precedence over the global `settings.json` values when set.
//!
//! The non-secret profile URL is persisted in the `projects.json` entry (and
//! mirrored into the project's `project.json` for display/export only — that
//! file sits in the project tree, where anything working there can rewrite it). The secret token lives only in the OS keyring
//! (`services::git_credentials`), keyed by project id — never on disk in our JSON
//! state. `git_push` / `publish_project` resolve the *effective* credentials via
//! [`effective_git_creds`]: the per-project value if present, else the global one.

use serde_json::Value;

use crate::schema::projects::ProjectsList;
use crate::services::git_credentials;
use crate::storage;

/// What the frontend gets back about a project's git hosting. The token itself is
/// never returned — only whether one is stored — so the secret stays out of the
/// renderer.
#[derive(serde::Serialize)]
pub struct GitHostingInfo {
    /// Per-project profile URL override, if any.
    pub profile_url: Option<String>,
    /// Whether a per-project token is stored in the keyring.
    pub has_token: bool,
    /// The global fallback profile URL (from settings.json), shown as the
    /// placeholder/inherited value in the editor.
    pub global_profile_url: Option<String>,
    /// Whether a global token exists to fall back on.
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
        global_profile_url: settings
            .as_ref()
            .and_then(|s| s.git_profile_url.clone())
            .filter(|s| !s.is_empty()),
        has_global_token: settings
            .as_ref()
            .and_then(|s| s.git_token.clone())
            .map(|t| !t.is_empty())
            .unwrap_or(false),
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
    // project.json descriptive/export mirror, in one serialized patch.
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

/// The credentials to actually use for a project's push/publish: the per-project
/// override if present, otherwise the global `settings.json` value. Returns
/// `(profile_url, token)`. Used by `git::git_push` and `git_publish::publish_project`.
pub fn effective_git_creds(project_id: &str) -> (Option<String>, Option<String>) {
    let settings = crate::storage::load_settings();

    let profile_url = project_profile_url(project_id)
        .ok()
        .flatten()
        .or_else(|| {
            settings
                .as_ref()
                .and_then(|s| s.git_profile_url.clone())
                .filter(|s| !s.is_empty())
        });

    // Per-project token (keyring) wins; else the global token from settings.json.
    let token = git_credentials::get_token(project_id).or_else(|| {
        settings
            .as_ref()
            .and_then(|s| s.git_token.clone())
            .filter(|s| !s.is_empty())
    });

    (profile_url, token)
}

/// The global access token from Settings → Git Hosting, if one is stored. For
/// work that has no project to key a per-project override off yet — `git_clone`
/// runs *before* the project exists — so only the global connection applies.
pub fn global_git_token() -> Option<String> {
    crate::storage::load_settings()
        .and_then(|s| s.git_token)
        .filter(|t| !t.trim().is_empty())
}

/// The per-project profile URL override, from the trusted `projects.json` entry.
fn project_profile_url(project_id: &str) -> Result<Option<String>, String> {
    let (idx, list) = find_entry(project_id)?;
    Ok(list[idx]
        .extra
        .get("git_profile_url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string))
}

/// The provider recorded on the trusted `projects.json` entry, if any.
fn project_provider(project_id: &str) -> Option<String> {
    let (idx, list) = find_entry(project_id).ok()?;
    list[idx]
        .extra
        .get("git_provider")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// `scheme://host[:port]` of an http(s) URL, lowercased; `None` for anything else.
fn url_origin(url: &str) -> Option<String> {
    let url = url.trim();
    let lower = url.to_ascii_lowercase();
    let scheme = ["https://", "http://"].into_iter().find(|s| lower.starts_with(s))?;
    let rest = &lower[scheme.len()..];
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    // Userinfo is never part of the host: `https://github.com@evil.example/`
    // is evil.example.
    let host = authority.rsplit('@').next().unwrap_or("");
    if host.is_empty() {
        return None;
    }
    Some(format!("{scheme}{host}"))
}

/// The origins a stored token may be handed to: the profile URL's own host
/// (project override, else global) plus the provider's public service. Anything
/// else — a push URL or `insteadOf` rewrite planted in `.git/config`, a pasted
/// clone URL — gets no token. `provider` overrides the recorded one (a first
/// publish runs before the provider is recorded).
pub fn token_origins(project_id: Option<&str>, provider: Option<&str>) -> Vec<String> {
    let settings = crate::storage::load_settings();
    let profile = project_id
        .and_then(|id| project_profile_url(id).ok().flatten())
        .or_else(|| settings.as_ref().and_then(|s| s.git_profile_url.clone()));
    let provider = provider
        .map(str::to_string)
        .or_else(|| project_id.and_then(project_provider));
    token_origins_for(profile.as_deref(), provider.as_deref())
}

fn token_origins_for(profile_url: Option<&str>, provider: Option<&str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(origin) = profile_url.and_then(url_origin) {
        out.push(origin);
    }
    let public = match provider {
        Some("gitlab") => "https://gitlab.com",
        _ => "https://github.com",
    };
    if !out.iter().any(|o| o == public) {
        out.push(public.to_string());
    }
    out
}

/// Find a project entry by id, returning its index and the owned list so the
/// caller can mutate + persist it. (Mirrors the helper in `commands::git_publish`.)
fn find_entry(project_id: &str) -> Result<(usize, ProjectsList), String> {
    let list_path = storage::projects_path();
    let list: ProjectsList = if list_path.exists() {
        storage::read_json(&list_path).map_err(|e| e.to_string())?
    } else {
        Vec::new()
    };
    let idx = list
        .iter()
        .position(|p| p.id == project_id)
        .ok_or_else(|| format!("project '{project_id}' not found"))?;
    Ok((idx, list))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_origin_keeps_scheme_host_and_port_only() {
        assert_eq!(url_origin("https://GitHub.com/me").as_deref(), Some("https://github.com"));
        assert_eq!(
            url_origin("https://git.example.org:8443/a/b").as_deref(),
            Some("https://git.example.org:8443")
        );
        assert_eq!(url_origin("ssh://git@github.com/x"), None);
        assert_eq!(url_origin("https://"), None);
    }

    #[test]
    fn userinfo_cannot_pose_as_the_host() {
        assert_eq!(
            url_origin("https://github.com@evil.example/me").as_deref(),
            Some("https://evil.example")
        );
    }

    #[test]
    fn token_origins_are_the_profile_host_plus_the_public_service() {
        assert_eq!(token_origins_for(None, None), vec!["https://github.com"]);
        assert_eq!(token_origins_for(None, Some("gitlab")), vec!["https://gitlab.com"]);
        assert_eq!(
            token_origins_for(Some("https://git.example.org/me"), Some("gitlab")),
            vec!["https://git.example.org", "https://gitlab.com"]
        );
        assert_eq!(
            token_origins_for(Some("https://github.com/me"), None),
            vec!["https://github.com"]
        );
    }
}

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

use crate::services::git_credentials;
// The credential resolution lives in `services::git_hosting` (S5).
pub use crate::services::git_hosting::{effective_git_creds, global_git_token, token_origins};
use crate::services::git_hosting::project_profile_url;

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

//! Which git-hosting credentials apply where.
//!
//! Two layers, both held only in the keyring
//! ([`crate::services::git_credentials`]):
//! - **host defaults**: one token per hosting origin the user listed in
//!   Settings → Git Hosting (`settings.git_hosts`, profile URLs; the token under
//!   the scope [`host_scope`]). Each is offered to its own origin only.
//! - **a project override** (scope = the project id), offered to the project's
//!   [`token_origins`]; while one is set, the host defaults play no part.
//!
//! Every git call that authenticates takes a [`GitAuth`]: per origin, the one
//! token git may hand to that origin. Builds before per-host tokens kept a
//! single plaintext `settings.git_token`; [`migrate_legacy_token`] moves it
//! into the keyring, and until that succeeds it still answers for its host.
//! Moved down from `commands::git_hosting` (S5), which re-exports these names.

use serde_json::Value;

use crate::schema::projects::ProjectsList;
use crate::schema::Settings;
use crate::services::git_credentials;

/// Hosts the Settings list takes. Each host's token rides in its own env var
/// ([`GIT_TOKEN_ENVS`]), so this also caps the grants of one git call.
pub const MAX_HOSTS: usize = 8;

/// The env vars a git child reads its tokens from, one per grant, in order.
/// Set only on the git (or hook-less transport) child itself; every list that
/// strips Tabtivity's secrets from a spawn names all of them.
pub const GIT_TOKEN_ENVS: [&str; MAX_HOSTS] = [
    crate::app_env!("GIT_TOKEN"),
    crate::app_env!("GIT_TOKEN_1"),
    crate::app_env!("GIT_TOKEN_2"),
    crate::app_env!("GIT_TOKEN_3"),
    crate::app_env!("GIT_TOKEN_4"),
    crate::app_env!("GIT_TOKEN_5"),
    crate::app_env!("GIT_TOKEN_6"),
    crate::app_env!("GIT_TOKEN_7"),
];

/// The keyring scope of a host's default token. Project ids never contain
/// `:`, so this cannot collide with a project's override.
pub fn host_scope(origin: &str) -> String {
    format!("host:{origin}")
}

/// Tokens for one git call: each offered only to its own origin, by an inline
/// credential helper scoped to that origin. Never `Debug`-prints a secret.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct GitAuth {
    grants: Vec<(String, String)>,
}

impl std::fmt::Debug for GitAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_list().entries(self.grants.iter().map(|(origin, _)| origin)).finish()
    }
}

impl GitAuth {
    /// No token anywhere: the user's own credential helpers (or SSH) answer.
    pub fn none() -> Self {
        Self::default()
    }

    /// `token` for every one of `origins` (a project override).
    pub fn single(token: &str, origins: &[String]) -> Self {
        let mut auth = Self::none();
        for origin in origins {
            auth.push(origin, token);
        }
        auth
    }

    /// Add `token` for `origin`, unless the origin already has one, the token
    /// is blank, or the call is full ([`MAX_HOSTS`]).
    fn push(&mut self, origin: &str, token: &str) {
        let token = token.trim();
        if token.is_empty() || self.grants.len() >= MAX_HOSTS || self.token_for(origin).is_some() {
            return;
        }
        self.grants.push((origin.to_string(), token.to_string()));
    }

    pub fn is_empty(&self) -> bool {
        self.grants.is_empty()
    }

    /// The token offered to `origin` (`scheme://host[:port]`, lowercase).
    pub fn token_for(&self, origin: &str) -> Option<&str> {
        self.grants.iter().find(|(o, _)| o == origin).map(|(_, t)| t.as_str())
    }

    /// The token git would hand to `url`'s origin; `None` for a non-http URL.
    pub fn token_for_url(&self, url: &str) -> Option<&str> {
        url_origin(url).and_then(|origin| self.token_for(&origin))
    }

    pub fn origins(&self) -> Vec<&str> {
        self.grants.iter().map(|(o, _)| o.as_str()).collect()
    }

    /// Every token, for redacting a git call's output.
    pub fn secrets(&self) -> Vec<&str> {
        self.grants.iter().map(|(_, t)| t.as_str()).collect()
    }

    /// `-c` pairs for the inline credential helpers, empty without a token. A
    /// leading empty `credential.helper=` clears every helper configured so far
    /// (a system GCM, any a repo's own config names) so only ours run; each
    /// origin's helper reads its own env var INSIDE the snippet, so no token
    /// lands in argv or on disk.
    ///
    /// Scoping by origin is the point: the push URL comes from `.git/config`,
    /// which a fenced agent can rewrite (`pushurl`, `insteadOf`), and an
    /// unscoped helper would hand a token to whatever server that names.
    /// Harmless for SSH remotes — git won't call an http helper.
    pub fn git_args(&self, username: &str) -> Vec<String> {
        if self.grants.is_empty() {
            return Vec::new();
        }
        let mut args = vec!["-c".to_string(), "credential.helper=".to_string()];
        for (i, (origin, _)) in self.grants.iter().enumerate() {
            let var = GIT_TOKEN_ENVS[i];
            let helper = format!(
                "!f() {{ test \"$1\" = get && echo username={username} && echo \"password=${var}\"; }}; f" // privacy-check: ok — an env-var NAME; the token is read at runtime, never written here
            );
            args.push("-c".to_string());
            args.push(format!("credential.{origin}.helper={helper}"));
        }
        args
    }

    /// Put the tokens [`Self::git_args`] reads into `cmd`'s environment.
    pub fn apply_env(&self, cmd: &mut std::process::Command) {
        for (i, (_, token)) in self.grants.iter().enumerate() {
            cmd.env(GIT_TOKEN_ENVS[i], token);
        }
    }
}

/// The per-project profile URL override, from the trusted `projects.json` entry.
pub(crate) fn project_profile_url(project_id: &str) -> Result<Option<String>, String> {
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
pub fn url_origin(url: &str) -> Option<String> {
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

/// The provider's public service.
fn public_origin(provider: Option<&str>) -> &'static str {
    match provider {
        Some("gitlab") => "https://gitlab.com",
        _ => "https://github.com",
    }
}

/// The origin an old build's single `git_token` belonged to: its profile
/// URL's host, else github.com (what it was offered to without one).
fn legacy_origin(settings: &Settings) -> String {
    settings
        .git_profile_url
        .as_deref()
        .and_then(url_origin)
        .unwrap_or_else(|| public_origin(None).to_string())
}

fn legacy_token(settings: &Settings) -> Option<&str> {
    settings.git_token.as_deref().map(str::trim).filter(|t| !t.is_empty())
}

/// The hosts listed in Settings → Git Hosting, as profile URLs, one per
/// origin, at most [`MAX_HOSTS`]. A file written before the list existed
/// reads as its single profile URL (or github.com, when it held only a token).
pub fn configured_hosts(settings: Option<&Settings>) -> Vec<String> {
    let Some(settings) = settings else { return Vec::new() };
    let raw: Vec<String> = match &settings.git_hosts {
        Some(list) => list.clone(),
        None => match settings.git_profile_url.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(url) => vec![url.to_string()],
            None if legacy_token(settings).is_some() => vec![public_origin(None).to_string()],
            None => Vec::new(),
        },
    };
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for url in raw {
        let url = url.trim().to_string();
        let Some(origin) = url_origin(&url) else { continue };
        if seen.contains(&origin) || out.len() >= MAX_HOSTS {
            continue;
        }
        seen.push(origin);
        out.push(url);
    }
    out
}

/// The default host's profile URL: the first listed. What a project without
/// its own profile URL falls back to.
pub fn default_profile_url(settings: Option<&Settings>) -> Option<String> {
    configured_hosts(settings).into_iter().next()
}

/// The token stored for `origin` as a host default.
pub fn host_token(origin: &str) -> Option<String> {
    host_token_in(crate::storage::load_settings().as_ref(), origin)
}

fn host_token_in(settings: Option<&Settings>, origin: &str) -> Option<String> {
    git_credentials::get_token(&host_scope(origin)).or_else(|| {
        // Not migrated yet (no keyring on this machine): the old single token
        // still answers for the host it belonged to.
        let settings = settings?;
        (legacy_origin(settings) == origin).then(|| legacy_token(settings).map(str::to_string)).flatten()
    })
}

/// Every host default, each for its own origin. What a project without its
/// own token uses, and a clone (which has no project yet).
pub fn hosts_auth() -> GitAuth {
    let settings = crate::storage::load_settings();
    let mut auth = GitAuth::none();
    for url in configured_hosts(settings.as_ref()) {
        let Some(origin) = url_origin(&url) else { continue };
        if let Some(token) = host_token_in(settings.as_ref(), &origin) {
            auth.push(&origin, &token);
        }
    }
    auth
}

/// The tokens a project's git calls use: its own override for its
/// [`token_origins`], else every host default. `provider` overrides the
/// recorded one (a first publish runs before the provider is recorded).
pub fn project_auth_for(project_id: Option<&str>, provider: Option<&str>) -> GitAuth {
    if let Some(token) = project_id.and_then(git_credentials::get_token) {
        return GitAuth::single(&token, &token_origins(project_id, provider));
    }
    hosts_auth()
}

pub fn project_auth(project_id: &str) -> GitAuth {
    project_auth_for(Some(project_id), None)
}

/// The token a provider CLI (`gh`, `glab`) runs with for a project: its
/// override, else the provider's public host default, else the first listed
/// host of that provider. The CLIs talk to their own default host, so there
/// is no per-URL choice to make here.
pub fn cli_token(project_id: Option<&str>, provider: &str) -> Option<String> {
    if let Some(token) = project_id.and_then(git_credentials::get_token) {
        return Some(token);
    }
    let settings = crate::storage::load_settings();
    let public = public_origin(Some(provider));
    host_token_in(settings.as_ref(), public).or_else(|| {
        configured_hosts(settings.as_ref())
            .iter()
            .filter(|url| url.to_ascii_lowercase().contains(provider))
            .filter_map(|url| url_origin(url))
            .find_map(|origin| host_token_in(settings.as_ref(), &origin))
    })
}

/// The origins a project's own token may be handed to: the profile URL's
/// host (project override, else the default host) plus the provider's public
/// service. Anything else — a push URL or `insteadOf` rewrite planted in
/// `.git/config`, a pasted clone URL — gets no token.
pub fn token_origins(project_id: Option<&str>, provider: Option<&str>) -> Vec<String> {
    let settings = crate::storage::load_settings();
    let profile = project_id
        .and_then(|id| project_profile_url(id).ok().flatten())
        .or_else(|| default_profile_url(settings.as_ref()));
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
    let public = public_origin(provider);
    if !out.iter().any(|o| o == public) {
        out.push(public.to_string());
    }
    out
}

/// Move an old build's plaintext `settings.git_token` into the keyring as its
/// host's default, list that host, and drop the plaintext. A host that
/// already has a keyring token keeps it (the plaintext is dropped all the
/// same). On a keyring failure nothing changes: the plaintext keeps answering
/// ([`host_token`]) and the next start tries again.
pub fn migrate_legacy_token() -> Result<(), String> {
    let path = crate::storage::settings_path();
    let Some(settings) = crate::storage::load_settings() else { return Ok(()) };
    let Some(token) = legacy_token(&settings) else { return Ok(()) };
    let origin = legacy_origin(&settings);
    let scope = host_scope(&origin);
    if git_credentials::get_token(&scope).is_none() {
        git_credentials::set_token(&scope, Some(token))?;
        if git_credentials::get_token(&scope).as_deref() != Some(token) {
            return Err("the keyring did not keep the git token".to_string());
        }
    }
    let hosts = configured_hosts(Some(&settings));
    crate::storage::patch_json(&path, Settings::default(), |current| {
        current.git_token = None;
        if current.git_hosts.is_none() {
            current.git_hosts = Some(hosts.clone());
        }
        current.rev += 1;
        Ok(())
    })
}

/// Find a project entry by id, returning its index and the owned list so the
/// caller can mutate + persist it. (Mirrors the helper in `commands::git_publish`.)
pub(crate) fn find_entry(project_id: &str) -> Result<(usize, ProjectsList), String> {
    let list = crate::services::project_registry::read_projects_list()?;
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

    #[test]
    fn each_origin_gets_its_own_helper_reading_its_own_variable() {
        let mut auth = GitAuth::none();
        auth.push("https://github.com", "tok-a");
        auth.push("https://gitlab.example.org", "tok-b");
        auth.push("https://github.com", "tok-c");
        let args = auth.git_args("x-access-token");
        assert_eq!(&args[..2], ["-c", "credential.helper="]);
        let helpers: Vec<&String> = args.iter().filter(|a| a.contains(".helper=!")).collect();
        assert_eq!(helpers.len(), 2, "one origin, one helper: the second github.com token is dropped");
        assert!(helpers[0].starts_with("credential.https://github.com.helper=!"));
        let tail = format!("${}\"; }}; f", GIT_TOKEN_ENVS[0]);
        assert!(helpers[0].ends_with(&tail));
        assert!(helpers[1].starts_with("credential.https://gitlab.example.org.helper=!"));
        assert!(helpers[1].contains(GIT_TOKEN_ENVS[1]));
        assert!(!args.iter().any(|a| a.contains("tok-")), "no token in argv");
        assert!(!args.iter().any(|a| a.starts_with("credential.helper=!")), "unscoped helper");
        assert_eq!(auth.token_for_url("https://user@gitlab.example.org/g/r.git"), Some("tok-b"));
        assert_eq!(auth.token_for_url("https://gitlab.com/g/r.git"), None);
        assert_eq!(auth.secrets(), vec!["tok-a", "tok-b"]);
        assert!(!format!("{auth:?}").contains("tok-"), "Debug never prints a token");
    }

    #[test]
    fn no_token_means_no_helper_so_the_users_own_answer() {
        assert!(GitAuth::none().git_args("x-access-token").is_empty());
        assert!(GitAuth::single("  ", &["https://github.com".into()]).is_empty());
    }

    #[test]
    fn a_call_carries_at_most_one_token_per_variable() {
        let mut auth = GitAuth::none();
        for i in 0..MAX_HOSTS + 3 {
            auth.push(&format!("https://h{i}.example"), "t");
        }
        assert_eq!(auth.origins().len(), MAX_HOSTS);
    }

    #[test]
    fn configured_hosts_read_the_list_or_the_old_single_profile() {
        let none = Settings::default();
        assert!(configured_hosts(Some(&none)).is_empty());

        let old_profile = Settings { git_profile_url: Some("https://gitlab.example.org/me".into()), ..Settings::default() };
        assert_eq!(configured_hosts(Some(&old_profile)), vec!["https://gitlab.example.org/me"]);

        let old_token_only = Settings { git_token: Some("t".into()), ..Settings::default() };
        assert_eq!(configured_hosts(Some(&old_token_only)), vec!["https://github.com"]);
        assert_eq!(legacy_origin(&old_token_only), "https://github.com");

        let list = Settings {
            git_profile_url: Some("https://ignored.example/me".into()),
            git_hosts: Some(vec![
                "https://github.com/me".into(),
                "not a url".into(),
                "https://GitHub.com/other".into(),
                "https://gitlab.com/me".into(),
            ]),
            ..Settings::default()
        };
        assert_eq!(configured_hosts(Some(&list)), vec!["https://github.com/me", "https://gitlab.com/me"]);
        assert_eq!(default_profile_url(Some(&list)).as_deref(), Some("https://github.com/me"));
    }
}

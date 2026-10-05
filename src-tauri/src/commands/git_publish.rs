//! Publishing a project's git repository to a hosting provider (GitHub or
//! GitLab), via the provider's official CLI (`gh` / `glab`).
//!
//! Publishing creates a remote repo from the project's git working tree and
//! pushes to it. The project's push target (`git_type`) is then updated to
//! `remote-<visibility>` and its `git_provider` recorded.
//!
//! Provider parity:
//! - GitHub uses `gh repo create … --source=. --remote=origin --push`, which
//!   creates the repo, wires `origin`, and pushes the existing history in one go.
//! - GitLab's `glab repo create` has no `--source/--push`: it creates the
//!   project and adds the `origin` remote, so we follow it with an explicit
//!   `git push -u origin HEAD` to upload the existing commits.
//!
//! A project's bytes may live locally or on an SSH work-remote host. **Where the
//! bytes are is not where the hosting account is**: `gh auth login`, and the
//! tokens in Settings → Git Hosting, are secrets of *this* machine, and a work
//! remote is typically a cluster login node with no provider CLI, no GitHub
//! credentials, and often no outbound https at all. A remote project also
//! already has a full local repo — the lockstep mirror
//! ([`remote_sync::mirror_dir`]) — holding the same history.
//!
//! So a remote project publishes **from its local mirror by default**
//! ([`PublishSite::Local`]), and the ssh path is retained as an explicit choice
//! (`publish_from = "remote"`) for a host that really does have its own
//! `gh`/`glab` login. Publishing from the mirror is refused unless lockstep is
//! on and reports the two sides in step — otherwise the mirror's history is not
//! the host's, and publishing would ship the wrong commits
//! ([`ensure_mirror_in_step`]).
//!
//! Every *follow-up* operation (visibility, unpublish, and `git_push` over in
//! `commands::git`) then routes to wherever `origin` actually got wired
//! ([`origin_site`]), so the create and the pushes never end up on opposite
//! sides.
//!
//! The ssh invocation mirrors `commands::ssh`: `BatchMode`, validated argv, no
//! shell string built from untrusted input — the remote path/name are
//! single-quoted for the remote shell. It relies on the work-remote host's own
//! `gh`/`glab` auth (we don't forward the token over ssh).

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

use crate::commands::git::run_off_thread;
use crate::commands::projects::{normalize_git_type, sanitize_name};
use crate::schema::project::Project;
use crate::schema::projects::ProjectsList;
use crate::services::git_peer::SyncStatus;
use crate::services::ssh_common::{ssh_base_args, validate_arg};
use crate::services::ssh_exec::shell_quote;
use crate::storage;

/// A supported git-hosting provider. Also used by `commands::git_fork`, which
/// drives the same two CLIs — one definition of "which CLI, which token env,
/// which host" rather than a second copy that can drift.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Provider {
    GitHub,
    GitLab,
}

impl Provider {
    /// Parse the frontend's provider string. Defaults to GitHub when omitted so
    /// older callers (and the historical single-provider behavior) keep working.
    pub(crate) fn parse(s: &str) -> Result<Self, String> {
        match s.trim().to_ascii_lowercase().as_str() {
            "" | "github" => Ok(Provider::GitHub),
            "gitlab" => Ok(Provider::GitLab),
            other => Err(format!(
                "provider must be 'github' or 'gitlab', got '{other}'"
            )),
        }
    }

    /// The canonical string persisted in `git_provider`.
    fn as_str(self) -> &'static str {
        match self {
            Provider::GitHub => "github",
            Provider::GitLab => "gitlab",
        }
    }

    /// The env var that lets the CLI authenticate non-interactively from a token
    /// (used for local publishing; the absent case falls back to the CLI's own
    /// `… auth login`).
    pub(crate) fn token_env(self) -> &'static str {
        match self {
            Provider::GitHub => "GH_TOKEN",
            Provider::GitLab => "GITLAB_TOKEN",
        }
    }

    /// The env var that points the CLI at a *self-hosted* instance (both CLIs
    /// default to their public service otherwise).
    pub(crate) fn host_env(self) -> &'static str {
        match self {
            Provider::GitHub => "GH_HOST",
            Provider::GitLab => "GITLAB_HOST",
        }
    }

    /// Whether `host` is the provider's public service, i.e. the host the CLI
    /// already assumes and must not be re-pointed at.
    pub(crate) fn is_default_host(self, host: &str) -> bool {
        let host = host.trim().to_ascii_lowercase();
        match self {
            Provider::GitHub => host == "github.com" || host == "www.github.com",
            Provider::GitLab => host == "gitlab.com" || host == "www.gitlab.com",
        }
    }

    /// The username an https credential helper presents alongside a PAT. Both
    /// providers ignore the username for PAT auth, but we use each one's
    /// convention.
    fn cred_username(self) -> &'static str {
        match self {
            Provider::GitHub => "x-access-token",
            Provider::GitLab => "oauth2",
        }
    }

    /// The provider's official CLI binary.
    pub(crate) fn cli(self) -> &'static str {
        match self {
            Provider::GitHub => "gh",
            Provider::GitLab => "glab",
        }
    }

    /// Display name for error text ("GitHub"/"GitLab"), distinct from
    /// `as_str()`'s lowercase persisted form.
    fn display_name(self) -> &'static str {
        match self {
            Provider::GitHub => "GitHub",
            Provider::GitLab => "GitLab",
        }
    }

    /// The `repo edit` argv that flips the current repo's visibility in place
    /// (no re-create). GitHub requires an explicit consent flag for the change.
    fn visibility_edit_args(self, visibility: &str) -> Vec<String> {
        match self {
            Provider::GitHub => vec![
                "repo".into(),
                "edit".into(),
                "--visibility".into(),
                visibility.into(),
                "--accept-visibility-change-consequences".into(),
            ],
            Provider::GitLab => vec![
                "repo".into(),
                "edit".into(),
                "--visibility".into(),
                visibility.into(),
            ],
        }
    }
}

/// Where a hosting operation runs. A *local* project has only one answer; a
/// work-remote project has two, because its history exists on both sides (the
/// lockstep mirror and the host), which is precisely why the choice has to be
/// named rather than inferred from "where the bytes are".
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PublishSite {
    /// Run the CLI in a local directory: a local project's tree, or a remote
    /// project's lockstep mirror. Uses *this* machine's `gh`/`glab` login and the
    /// effective per-project → global token.
    Local(PathBuf),
    /// Run the CLI over ssh on the work-remote host, using that host's own login.
    Host,
}

/// Parse the dialog's "Publish from" choice. Defaults to the local mirror: the
/// hosting account is this machine's, so that is the side that can actually
/// authenticate. `"remote"` opts into the host's own `gh`/`glab` login.
fn parse_publish_from(s: Option<&str>) -> Result<PublishSite, String> {
    match s.unwrap_or("local").trim().to_ascii_lowercase().as_str() {
        "" | "local" | "mirror" => Ok(PublishSite::Local(PathBuf::new())),
        "remote" | "host" => Ok(PublishSite::Host),
        other => Err(format!(
            "publish_from must be 'local' or 'remote', got '{other}'"
        )),
    }
}

/// A remote project's lockstep mirror, when it actually holds a git repo.
fn mirror_repo(project_id: &str) -> Option<PathBuf> {
    let dir = crate::services::remote_sync::mirror_dir(project_id);
    dir.join(".git").exists().then_some(dir)
}

/// Whether a local repo has an `origin` remote — i.e. whether a publish wired
/// one here.
fn has_origin(dir: &Path) -> bool {
    use crate::services::git_bounded::BoundedOutput;
    crate::paths::command_no_window("git")
        .current_dir(dir)
        .args(["remote", "get-url", "origin"])
        .bounded_output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// The mirror of a remote project **when `origin` was wired there**, i.e. when
/// the project published from this machine. `commands::git::git_push` routes
/// through this so the pushes land on the same side the repo was created on —
/// otherwise a mirror-side publish would be followed by host-side pushes into an
/// `origin` that does not exist there.
pub(crate) fn mirror_origin_repo(project_id: &str) -> Option<PathBuf> {
    mirror_repo(project_id).filter(|dir| has_origin(dir))
}

/// The project as publish/unpublish/visibility may act on it: `project.json`
/// for descriptive data, with every field that decides *where* an operation runs
/// or *what* it publishes taken from the trusted `projects.json` entry instead.
/// `project.json` lives inside the project tree, where a fenced agent, a
/// container tab or a `git pull` can rewrite it — and a `directory` read from
/// there would aim "Publish (public)" at some other repository on disk.
fn trusted_project(entry: &crate::schema::ProjectEntry) -> Project {
    let mut project: Project = storage::read_json(Path::new(&entry.local_file)).unwrap_or_default();
    let text = |key: &str| {
        entry
            .extra
            .get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    project.id = entry.id.clone();
    project.name = entry.name.clone();
    project.directory = text("directory")
        .or_else(|| {
            Path::new(&entry.local_file)
                .parent()
                .map(|p| p.to_string_lossy().into_owned())
        })
        .unwrap_or_default();
    project.remote = entry
        .extra
        .get("remote")
        .and_then(|v| serde_json::from_value(v.clone()).ok());
    project.git_type = text("git_type");
    project.git_provider = text("git_provider");
    project
}

/// A local project's tree, checked to exist.
fn local_dir(project: &Project) -> Result<PathBuf, String> {
    let dir = PathBuf::from(&project.directory);
    if !dir.is_dir() {
        return Err(format!(
            "Project directory does not exist: {}",
            project.directory
        ));
    }
    Ok(dir)
}

/// Refuse a mirror-side publish unless lockstep can vouch that the mirror holds
/// the host's commits.
///
/// This is the one hazard the local default introduces: the mirror is a *real*
/// repo whether or not it is current, so an unguarded publish would happily
/// create the repository and push a stale — possibly scaffold-only — history
/// under the project's name. Only a green lockstep means "these are the same
/// commits"; every other state is reported with what to do about it.
fn ensure_mirror_in_step(project_id: &str) -> Result<(), String> {
    let state = crate::services::git_peer::load_state(project_id);
    match describe_mirror_guard(state.enabled, state.status, state.detail) {
        Some(msg) => Err(msg),
        None => Ok(()),
    }
}

/// The refusal text for a lockstep state, or `None` when the mirror may publish.
/// Pure, so the policy — which is the whole safety of the local default — is
/// unit-tested without a state dir.
fn describe_mirror_guard(
    enabled: bool,
    status: SyncStatus,
    detail: Option<String>,
) -> Option<String> {
    if !enabled {
        return Some(
            "Git lockstep is off for this project, so the local mirror is not kept in step \
             with the host and may not hold the host's commits. Turn lockstep on and let it \
             sync, or publish from the work-remote host instead."
                .to_string(),
        );
    }
    match status {
        SyncStatus::Synchronized => None,
        SyncStatus::Syncing => {
            Some("Lockstep is still syncing — wait for it to finish, then publish.".to_string())
        }
        SyncStatus::Disconnected => Some(
            "Lockstep cannot see the host, so it cannot confirm the local mirror holds the \
             host's commits. Connect the project and let it sync, then publish."
                .to_string(),
        ),
        SyncStatus::Desynchronized => {
            let detail = detail.map(|d| format!(" ({d})")).unwrap_or_default();
            Some(format!(
                "The local mirror and the host are out of step{detail} — publishing now would \
                 create the repository from the mirror's history. Reconcile lockstep first, or \
                 publish from the work-remote host instead."
            ))
        }
    }
}

/// Where a **create** runs: the project's own tree for a local project, and for
/// a remote one the caller's choice (mirror by default, guarded by lockstep).
fn publish_site(
    project: &Project,
    project_id: &str,
    publish_from: Option<&str>,
) -> Result<PublishSite, String> {
    // A local project has no second side to choose between; the flag is ignored
    // rather than rejected, so a dialog may always send it.
    if project.remote.is_none() {
        return Ok(PublishSite::Local(local_dir(project)?));
    }
    match parse_publish_from(publish_from)? {
        PublishSite::Host => Ok(PublishSite::Host),
        PublishSite::Local(_) => {
            let mirror = mirror_repo(project_id).ok_or_else(|| {
                "This remote project has no local mirror repository to publish from. Turn git \
                 lockstep on to create one, or publish from the work-remote host instead."
                    .to_string()
            })?;
            ensure_mirror_in_step(project_id)?;
            Ok(PublishSite::Local(mirror))
        }
    }
}

/// Where a **follow-up** operation runs (visibility, unpublish, push): wherever
/// `origin` actually got wired. No choice to make — the answer is a fact about
/// the repos, and guessing it wrong means editing/removing a remote on the side
/// that doesn't have one.
fn origin_site(project: &Project, project_id: &str) -> Result<PublishSite, String> {
    if project.remote.is_none() {
        return Ok(PublishSite::Local(local_dir(project)?));
    }
    Ok(mirror_origin_repo(project_id)
        .map(PublishSite::Local)
        .unwrap_or(PublishSite::Host))
}

/// Publish a project's git repository to a hosting provider and record the new
/// push target.
///
/// `provider` is "github" or "gitlab" (defaulting to GitHub when empty).
/// `visibility` must be "public" or "private". `publish_from` selects the side
/// for a work-remote project — `"local"` (default: the lockstep mirror, using
/// this machine's provider login) or `"remote"` (the host's own login). Returns
/// the CLI's stdout (typically the new repository URL) on success, or the
/// trimmed stderr on failure.
///
/// Every command in this module is an `async` wrapper over a sync `*_blocking`
/// body run through [`run_off_thread`] (the same pattern as `commands::git`):
/// the bodies spawn `git`/`gh`/`glab` or ssh and block on them, and a sync
/// Tauri command runs on the main thread, so a slow push or an unreachable host
/// froze the whole window for its duration.
#[tauri::command]
pub async fn publish_project(
    project_id: String,
    provider: Option<String>,
    visibility: String,
    publish_from: Option<String>,
) -> Result<String, String> {
    run_off_thread(move || {
        publish_project_blocking(project_id, provider, visibility, publish_from)
    })
    .await
}

fn publish_project_blocking(
    project_id: String,
    provider: Option<String>,
    visibility: String,
    publish_from: Option<String>,
) -> Result<String, String> {
    let provider = Provider::parse(provider.as_deref().unwrap_or("github"))?;
    let visibility = match visibility.trim() {
        "public" => "public",
        "private" => "private",
        other => {
            return Err(format!(
                "visibility must be 'public' or 'private', got '{other}'"
            ))
        }
    };

    let (entry_index, list) = find_entry(&project_id)?;
    let project = trusted_project(&list[entry_index]);

    // Repo names can't contain spaces/special chars; reuse the project name
    // sanitizer that already produces a safe slug for local directories.
    let repo_name = sanitize_name(&project.name);
    if repo_name.is_empty() {
        return Err("Project name does not yield a valid repository name".to_string());
    }

    // Effective per-project → global token. When set, run the CLI as that token's
    // account via the provider's token env var instead of relying on the ambient
    // `… auth login`.
    let (_profile, token) = crate::commands::git_hosting::effective_git_creds(&project_id);

    let stdout = match publish_site(&project, &project_id, publish_from.as_deref())? {
        // Local project's tree, or a remote project's lockstep mirror: run the CLI
        // here, with this machine's provider login / effective token.
        PublishSite::Local(dir) => local_publish(
            provider,
            &dir,
            &repo_name,
            visibility,
            token.as_deref(),
            // A remote project's `Local` site is its lockstep mirror, whose
            // branch names have to keep matching the host's.
            project.remote.is_none(),
            &project_id,
        )?,
        // Explicit opt-in: run the CLI on the work-remote host, relying on that
        // host's own provider auth (the local token is never forwarded over ssh).
        PublishSite::Host => {
            let remote = project
                .remote
                .as_ref()
                .ok_or_else(|| "Project is not a work-remote project".to_string())?;
            let base = ssh_base_args(&remote.user, &remote.host, remote.port)?;
            validate_arg("remote_path", &remote.remote_path)?;
            let script =
                remote_publish_script(provider, &remote.remote_path, &repo_name, visibility);
            // `command_no_window` avoids a console-window flash on Windows.
            run_remote_provider_command(
                crate::paths::command_no_window("ssh")
                    .args(&base)
                    .arg(script),
                provider,
            )?
        }
    };

    // Reflect the new push target + provider in both projects.json and project.json.
    let new_git_type = normalize_git_type(&format!("remote-{visibility}"));
    crate::commands::projects::patch_project_entry_mirrored(
        &project_id,
        |entry| {
            entry
                .extra
                .insert("git_type".to_string(), Value::String(new_git_type.clone()));
            entry.extra.insert(
                "git_provider".to_string(),
                Value::String(provider.as_str().to_string()),
            );
            Ok(())
        },
        |p, ()| {
            p.git_type = Some(new_git_type.clone());
            p.git_provider = Some(provider.as_str().to_string());
        },
    )?;

    Ok(stdout.trim().to_string())
}

/// Whether a project's recorded hosting push target actually **exists** — i.e.
/// whether a publish ever wired an `origin` remote.
///
/// `git_type: "remote-*"` is only a label, and it is not written by
/// [`publish_project`] alone: the new-project dialog's "Push to GitHub/GitLab"
/// choice records it too. A project in that state claims to be published while
/// having no repository on the host, no `origin`, and — since the Push button
/// keys off an upstream branch — no way to push either. The pill reads this so it
/// can offer *Publish…* for such a project instead of the manage-an-existing-repo
/// actions (visibility, migrate, unpublish), every one of which would fail.
///
/// Local projects only. A work-remote project's `origin` may legitimately live on
/// its host, and asking would be an ssh round trip, so those answer `true` —
/// "nothing here contradicts the label".
///
/// Off-thread even though it is a local `git remote get-url`: the pill calls it
/// on every right-click of a published project, and a fork+wait on the main
/// thread there is a visible hitch before the context menu opens.
#[tauri::command]
pub async fn project_has_origin(project_id: String) -> Result<bool, String> {
    run_off_thread(move || project_has_origin_blocking(project_id)).await
}

fn project_has_origin_blocking(project_id: String) -> Result<bool, String> {
    let (entry_index, list) = find_entry(&project_id)?;
    let project = trusted_project(&list[entry_index]);
    if project.remote.is_some() {
        return Ok(true);
    }
    Ok(has_origin(Path::new(&project.directory)))
}

/// Unpublish a project: forget its hosting push target **without** deleting
/// either its local history or the hosted repository. Removes the `origin`
/// remote (locally, or over ssh on the work-remote host where the repo lives),
/// resets `git_type` to `"local"`, and clears `git_provider`.
///
/// This is the safe inverse of `publish_project`: commits are never touched and
/// the GitHub/GitLab repo is left intact — only the local tree is detached from
/// it. Re-publishing later re-creates or re-attaches a remote.
#[tauri::command]
pub async fn unpublish_project(project_id: String) -> Result<(), String> {
    run_off_thread(move || unpublish_project_blocking(project_id)).await
}

fn unpublish_project_blocking(project_id: String) -> Result<(), String> {
    let (idx, list) = find_entry(&project_id)?;
    let project = trusted_project(&list[idx]);

    let gt = project
        .git_type
        .as_deref()
        .map(normalize_git_type)
        .unwrap_or_default();
    if !gt.starts_with("remote") {
        return Err("Project is not published to a remote".to_string());
    }

    // Drop `origin` where it actually is — the mirror for a project published
    // from this machine, the host for one published over ssh. Removing it from
    // the wrong side would leave the real one wired and silently destroy a remote
    // the user configured themselves.
    match origin_site(&project, &project_id)? {
        PublishSite::Local(dir) => {
            // Ignore failure (e.g. origin already absent) — desired end state is "no origin".
            let _ = crate::services::git_bounded::BoundedOutput::bounded_output(
                crate::paths::command_no_window("git")
                    .current_dir(&dir)
                    .args(["remote", "remove", "origin"]),
            );
        }
        PublishSite::Host => {
            let remote = project
                .remote
                .as_ref()
                .ok_or_else(|| "Project is not a work-remote project".to_string())?;
            let base = ssh_base_args(&remote.user, &remote.host, remote.port)?;
            validate_arg("remote_path", &remote.remote_path)?;
            let path = shell_quote(&remote.remote_path);
            // A missing origin is fine — the goal state is simply "no origin".
            let script = format!("cd {path} && git remote remove origin 2>/dev/null || true");
            run_command(
                crate::paths::command_no_window("ssh")
                    .args(&base)
                    .arg(script),
            )?;
        }
    }

    crate::commands::projects::patch_project_entry_mirrored(
        &project_id,
        |entry| {
            entry
                .extra
                .insert("git_type".to_string(), Value::String("local".to_string()));
            entry.extra.remove("git_provider");
            Ok(())
        },
        |p, ()| {
            p.git_type = Some("local".to_string());
            p.git_provider = None;
        },
    )?;
    Ok(())
}

/// Flip a published project's repository visibility (public ↔ private) in place
/// via the provider's `repo edit` verb — no re-create, so the repo, its URL, and
/// its history are preserved. Updates `git_type` to `remote-<visibility>`.
///
/// Runs locally, or over ssh on the work-remote host for a remote project
/// (relying on that host's provider auth, exactly like `publish_project`).
#[tauri::command]
pub async fn set_project_visibility(
    project_id: String,
    visibility: String,
) -> Result<String, String> {
    run_off_thread(move || set_project_visibility_blocking(project_id, visibility)).await
}

fn set_project_visibility_blocking(
    project_id: String,
    visibility: String,
) -> Result<String, String> {
    let visibility = match visibility.trim() {
        "public" => "public",
        "private" => "private",
        other => {
            return Err(format!(
                "visibility must be 'public' or 'private', got '{other}'"
            ))
        }
    };

    let (idx, list) = find_entry(&project_id)?;
    let project = trusted_project(&list[idx]);

    let gt = project
        .git_type
        .as_deref()
        .map(normalize_git_type)
        .unwrap_or_default();
    if !gt.starts_with("remote") {
        return Err("Project is not published to a remote".to_string());
    }
    let provider = Provider::parse(project.git_provider.as_deref().unwrap_or("github"))?;

    // `repo edit` acts on the repo `origin` points at, so it has to run on the
    // side that has one.
    let stdout = match origin_site(&project, &project_id)? {
        PublishSite::Local(dir) => {
            let (_profile, token) = crate::commands::git_hosting::effective_git_creds(&project_id);
            local_set_visibility(provider, &dir, visibility, token.as_deref())?
        }
        PublishSite::Host => {
            let remote = project
                .remote
                .as_ref()
                .ok_or_else(|| "Project is not a work-remote project".to_string())?;
            let base = ssh_base_args(&remote.user, &remote.host, remote.port)?;
            validate_arg("remote_path", &remote.remote_path)?;
            let script = remote_visibility_script(provider, &remote.remote_path, visibility);
            run_remote_provider_command(
                crate::paths::command_no_window("ssh")
                    .args(&base)
                    .arg(script),
                provider,
            )?
        }
    };

    let new_git_type = normalize_git_type(&format!("remote-{visibility}"));
    crate::commands::projects::patch_project_entry_mirrored(
        &project_id,
        |entry| {
            entry
                .extra
                .insert("git_type".to_string(), Value::String(new_git_type.clone()));
            Ok(())
        },
        |p, ()| p.git_type = Some(new_git_type.clone()),
    )?;
    Ok(stdout.trim().to_string())
}

/// Migrate a published project to the **other** hosting provider. Because this
/// is a true migration (not a rename), the existing `origin` is moved aside to
/// `origin-old` — the old provider's repository is intentionally **left intact**
/// (we never delete someone's hosted repo) and stays reachable as `origin-old` —
/// then a fresh publish creates the repo on the new provider, wires `origin`,
/// and pushes. Records the new `git_provider` + `git_type` (via the reused
/// `publish_project`). Returns the create CLI's stdout (new repo URL).
#[tauri::command]
pub async fn switch_project_provider(
    project_id: String,
    provider: Option<String>,
    visibility: String,
    publish_from: Option<String>,
) -> Result<String, String> {
    run_off_thread(move || {
        switch_project_provider_blocking(project_id, provider, visibility, publish_from)
    })
    .await
}

fn switch_project_provider_blocking(
    project_id: String,
    provider: Option<String>,
    visibility: String,
    publish_from: Option<String>,
) -> Result<String, String> {
    let new_provider = Provider::parse(provider.as_deref().unwrap_or("github"))?;
    let visibility = match visibility.trim() {
        "public" | "private" => visibility.trim().to_string(),
        other => {
            return Err(format!(
                "visibility must be 'public' or 'private', got '{other}'"
            ))
        }
    };

    let (idx, list) = find_entry(&project_id)?;
    let project = trusted_project(&list[idx]);

    let gt = project
        .git_type
        .as_deref()
        .map(normalize_git_type)
        .unwrap_or_default();
    if !gt.starts_with("remote") {
        return Err("Project is not published — use Publish instead".to_string());
    }
    if project.git_provider.as_deref() == Some(new_provider.as_str()) {
        return Err(format!("Project is already on {}", new_provider.as_str()));
    }

    // Move the existing origin aside so a fresh publish can wire a new one. The
    // old hosted repo is intentionally left intact (reachable as origin-old).
    // This targets the side that *has* the origin, which need not be the side the
    // new publish will use.
    rename_origin_aside(origin_site(&project, &project_id)?, &project)?;

    // Delegate the create+wire+push+persist to the normal publish path, now
    // targeting the new provider. This must call the sync `_blocking` body, not
    // the `publish_project` command: we are already inside `run_off_thread`'s
    // closure, a non-async context that cannot `.await` the async wrapper.
    publish_project_blocking(
        project_id,
        Some(new_provider.as_str().to_string()),
        visibility,
        publish_from,
    )
}

/// Run the provider's `repo edit --visibility` for a *local* project.
fn local_set_visibility(
    provider: Provider,
    dir: &PathBuf,
    visibility: &str,
    token: Option<&str>,
) -> Result<String, String> {
    let mut cmd = crate::paths::command_no_window(provider.cli());
    cmd.current_dir(dir)
        .args(provider.visibility_edit_args(visibility));
    if let Some(tok) = token {
        cmd.env(provider.token_env(), tok);
    }
    run_provider_command(&mut cmd, provider)
}

/// Build the remote-host shell script that flips visibility over ssh. `visibility`
/// is a fixed `public`/`private` literal (validated by the caller); `remote_path`
/// is single-quoted for the remote shell.
fn remote_visibility_script(provider: Provider, remote_path: &str, visibility: &str) -> String {
    let path = shell_quote(remote_path);
    let args = provider.visibility_edit_args(visibility).join(" ");
    format!("cd {path} && {} {args}", provider.cli())
}

/// Rename a project's existing `origin` remote to `origin-old` (best effort),
/// dropping any stale prior `origin-old` first. Runs at `site` — the side that
/// actually holds the origin. Used by `switch_project_provider` so a fresh
/// publish can wire a new `origin` without clobbering the reference to the old
/// repo.
fn rename_origin_aside(site: PublishSite, project: &Project) -> Result<(), String> {
    match site {
        PublishSite::Local(dir) => {
            use crate::services::git_bounded::BoundedOutput;
            let _ = crate::paths::command_no_window("git")
                .current_dir(&dir)
                .args(["remote", "remove", "origin-old"])
                .bounded_output();
            let _ = crate::paths::command_no_window("git")
                .current_dir(&dir)
                .args(["remote", "rename", "origin", "origin-old"])
                .bounded_output();
        }
        PublishSite::Host => {
            let remote = project
                .remote
                .as_ref()
                .ok_or_else(|| "Project is not a work-remote project".to_string())?;
            let base = ssh_base_args(&remote.user, &remote.host, remote.port)?;
            validate_arg("remote_path", &remote.remote_path)?;
            let path = shell_quote(&remote.remote_path);
            let script = format!(
                "cd {path} && git remote remove origin-old 2>/dev/null; \
                 git remote rename origin origin-old 2>/dev/null || true"
            );
            run_command(
                crate::paths::command_no_window("ssh")
                    .args(&base)
                    .arg(script),
            )?;
        }
    }
    Ok(())
}

/// Run the provider's create (and, for GitLab, an explicit push) for a *local*
/// project, returning the combined CLI stdout.
///
/// `rename_master` asks for the [`git_init::ensure_default_branch`] pass first:
/// both CLIs make the branch they receive the new repository's default, so a
/// project still on git's old built-in `master` would name the hosted default
/// branch `master`. Only a plain local project opts in — see that module for why
/// a lockstep mirror must keep the branch name the host knows it by.
#[allow(clippy::too_many_arguments)]
fn local_publish(
    provider: Provider,
    dir: &PathBuf,
    repo_name: &str,
    visibility: &str,
    token: Option<&str>,
    rename_master: bool,
    project_id: &str,
) -> Result<String, String> {
    // Both branches push from `dir` (gh's `--push` runs `git push` itself), so
    // the repo's hooks run here: ask-once gate, as for Push.
    crate::services::exec_trust::require(crate::services::exec_trust::TrustKind::GitHooks, dir)?;
    if rename_master {
        crate::services::git_init::ensure_default_branch(dir);
    }
    match provider {
        // `gh repo create` creates, wires origin, and pushes in one command.
        Provider::GitHub => {
            let mut cmd = crate::paths::command_no_window("gh");
            cmd.current_dir(dir).args([
                "repo",
                "create",
                repo_name,
                &format!("--{visibility}"),
                "--source=.",
                "--remote=origin",
                "--push",
            ]);
            // gh's own `git push` runs in `dir` too: same common-dir pin (#862).
            crate::commands::git::pin_common_dir(&mut cmd, dir);
            if let Some(tok) = token {
                cmd.env(provider.token_env(), tok);
            }
            run_provider_command(&mut cmd, provider)
        }
        // `glab repo create` creates the project and adds `origin`, but does not
        // push existing history — so do that as a second, token-authenticated step.
        Provider::GitLab => {
            let mut create = crate::paths::command_no_window("glab");
            create.current_dir(dir).args([
                "repo",
                "create",
                repo_name,
                &format!("--{visibility}"),
                "--remoteName",
                "origin",
            ]);
            if let Some(tok) = token {
                create.env(provider.token_env(), tok);
            }
            let mut out = run_provider_command(&mut create, provider)?;

            let mut args: Vec<String> = Vec::new();
            if token.is_some() {
                let origins = crate::commands::git_hosting::token_origins(
                    Some(project_id),
                    Some(provider.as_str()),
                );
                args.extend(crate::commands::git::scoped_token_config(
                    &origins,
                    provider.cred_username(),
                ));
            }
            args.extend(["push", "-u", "origin", "HEAD"].map(String::from));
            let mut push = crate::commands::git::hooked_git_command_in(dir, &args);
            if let Some(tok) = token {
                push.env(crate::app_env!("GIT_TOKEN"), tok);
                push.env("GIT_TERMINAL_PROMPT", "0");
            }
            out.push('\n');
            out.push_str(&run_command(&mut push)?);
            Ok(out)
        }
    }
}

/// Build the remote-host shell script that performs the publish over ssh.
fn remote_publish_script(
    provider: Provider,
    remote_path: &str,
    repo_name: &str,
    visibility: &str,
) -> String {
    let path = shell_quote(remote_path);
    let name = shell_quote(repo_name);
    match provider {
        Provider::GitHub => format!(
            "cd {path} && gh repo create {name} --{visibility} --source=. --remote=origin --push"
        ),
        // Mirror the local two-step flow on the remote; the remote host's git
        // credentials/ssh auth carry the push.
        Provider::GitLab => format!(
            "cd {path} && glab repo create {name} --{visibility} --remoteName origin \
             && git push -u origin HEAD"
        ),
    }
}

/// Find a project entry by id, returning its index and the full (owned) list so
/// the caller can mutate + persist it.
fn find_entry(project_id: &str) -> Result<(usize, ProjectsList), String> {
    let list_path = storage::state_dir().join("projects.json");
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

/// Run a command, returning trimmed stdout on success or a useful error
/// (stderr, else stdout, else a generic message) on failure.
fn run_command(cmd: &mut Command) -> Result<String, String> {
    let output = cmd
        .output()
        .map_err(|e| format!("failed to run command: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if !stderr.is_empty() {
            return Err(stderr);
        }
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !stdout.is_empty() {
            return Err(stdout);
        }
        return Err("command failed".to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Run a provider CLI (`gh`/`glab`) invocation, turning its two most common
/// failures — not installed, not signed in — into an actionable message
/// instead of the CLI's own terse (or, for a local "not installed", raw OS)
/// wording. The dialog pre-empts both cases for anything running on this machine
/// (`provider_cli_available`, `effective_git_creds`) — which since the local
/// default includes a remote project's mirror publish. Only the explicit
/// **work-remote host** choice is never probed ahead of time, so this is the one
/// place that failure surfaces for it: the CLI runs inside a shell script over
/// ssh, so "not installed" there is just stderr text (`… command not found`),
/// never a local `io::Error`.
fn run_provider_command(cmd: &mut Command, provider: Provider) -> Result<String, String> {
    match cmd.output() {
        Ok(output) => {
            if output.status.success() {
                return Ok(String::from_utf8_lossy(&output.stdout).to_string());
            }
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let raw = if !stderr.is_empty() {
                stderr
            } else if !stdout.is_empty() {
                stdout
            } else {
                "command failed".to_string()
            };
            Err(friendly_publish_error(provider, &raw))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(not_installed_error(provider)),
        Err(e) => Err(format!("failed to run command: {e}")),
    }
}

/// Run a provider CLI invocation that is wrapped in `ssh`, where a failure may
/// come from the *transport* rather than the CLI. `ssh_base_args` is
/// `BatchMode=yes` + `ControlMaster=no`: it rides an existing master but never
/// creates one, so a project that isn't currently connected fails at ssh auth
/// before `gh`/`glab` ever runs — and OpenSSH's wording ("Permission denied
/// (publickey,password)") reads like a *GitHub* rejection if passed through as-is.
fn run_remote_provider_command(cmd: &mut Command, provider: Provider) -> Result<String, String> {
    run_provider_command(cmd, provider).map_err(|e| match ssh_transport_error(&e) {
        Some(msg) => msg,
        None => e,
    })
}

/// Recognize OpenSSH's own failure wording and say what it actually means. Each
/// pattern is one OpenSSH emits verbatim — deliberately narrow, so a provider
/// message that merely contains "denied" is not mistaken for a transport failure.
fn ssh_transport_error(raw: &str) -> Option<String> {
    let lower = raw.to_ascii_lowercase();
    let transport = lower.contains("permission denied (public")
        || lower.contains("ssh: connect to host")
        || lower.contains("could not resolve hostname")
        || lower.contains("host key verification failed")
        || lower.contains("kex_exchange_identification")
        || lower.contains("connection closed by remote host")
        || lower.contains("connection timed out during banner exchange")
        || lower.contains("operation timed out");
    transport.then(|| {
        format!(
            "Could not reach the work-remote host over SSH, so the publish never started. \
             Connect the project first (the pill's connection lamp must be green), or publish \
             from this computer's local mirror instead.\n\n{}",
            raw.trim()
        )
    })
}

/// The message for "the provider CLI isn't on this machine (or the remote
/// host)" — the most common wall a first publish hits.
fn not_installed_error(provider: Provider) -> String {
    let cli = provider.cli();
    format!(
        "{cli} is not installed — publishing to {} creates the repository through \
         the provider's own CLI, which plain git cannot do. Install {cli}, then run \
         `{cli} auth login` (or store an access token in Settings → Git Hosting) \
         before publishing.",
        provider.display_name()
    )
}

/// Turn a provider CLI's own failure text into the sentence that says what to
/// do about it. Mirrors `commands::git_fork::api_error`'s two cases (not
/// installed, not signed in) for the create/publish path.
fn friendly_publish_error(provider: Provider, raw: &str) -> String {
    let lower = raw.to_ascii_lowercase();
    let cli = provider.cli();
    // Shell "binary not found" wording, GitHub/GitLab's install docs cover
    // bash/sh/PowerShell: "command not found", "gh: not found", "is not
    // recognized as an internal or external command" (Windows cmd/PowerShell).
    if lower.contains("command not found")
        || lower.contains(&format!("{cli}: not found"))
        || lower.contains("is not recognized as")
    {
        return not_installed_error(provider);
    }
    if lower.contains("not logged")
        || lower.contains("authentication")
        || lower.contains("401")
        || lower.contains("unauthorized")
    {
        return format!(
            "{}\n\nPublishing uses the {cli} CLI's own login — run `{cli} auth login` \
             (or store an access token in Settings → Git Hosting).",
            raw.trim()
        );
    }
    raw.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_quote_wraps_plain_value() {
        assert_eq!(shell_quote("/home/user/proj"), "'/home/user/proj'");
    }

    #[test]
    fn shell_quote_escapes_embedded_single_quotes() {
        assert_eq!(shell_quote("a'b"), r"'a'\''b'");
        // The result is a safe single-quoted shell token (no unescaped quote
        // breaks out of the quoting).
        assert!(shell_quote("; rm -rf /").starts_with('\''));
    }

    #[test]
    fn provider_parse_defaults_and_validates() {
        assert!(matches!(Provider::parse(""), Ok(Provider::GitHub)));
        assert!(matches!(Provider::parse("GitHub"), Ok(Provider::GitHub)));
        assert!(matches!(Provider::parse("gitlab"), Ok(Provider::GitLab)));
        assert!(Provider::parse("bitbucket").is_err());
    }

    #[test]
    fn github_remote_script_is_single_command_push() {
        let s = remote_publish_script(Provider::GitHub, "/srv/proj", "my-proj", "public");
        assert_eq!(
            s,
            "cd '/srv/proj' && gh repo create 'my-proj' --public --source=. --remote=origin --push"
        );
    }

    #[test]
    fn gitlab_remote_script_creates_then_pushes() {
        let s = remote_publish_script(Provider::GitLab, "/srv/proj", "my-proj", "private");
        assert!(s.contains("glab repo create 'my-proj' --private --remoteName origin"));
        assert!(s.contains("&& git push -u origin HEAD"));
    }

    #[test]
    fn github_visibility_edit_requires_consent_flag() {
        let args = Provider::GitHub.visibility_edit_args("private");
        assert_eq!(
            args,
            vec![
                "repo",
                "edit",
                "--visibility",
                "private",
                "--accept-visibility-change-consequences"
            ]
        );
    }

    #[test]
    fn gitlab_visibility_edit_has_no_consent_flag() {
        let args = Provider::GitLab.visibility_edit_args("public");
        assert_eq!(args, vec!["repo", "edit", "--visibility", "public"]);
    }

    #[test]
    fn remote_visibility_script_quotes_path_and_uses_cli() {
        let s = remote_visibility_script(Provider::GitLab, "/srv/proj", "public");
        assert_eq!(s, "cd '/srv/proj' && glab repo edit --visibility public");
    }

    #[test]
    fn friendly_error_flags_missing_cli_across_shells() {
        assert!(
            friendly_publish_error(Provider::GitHub, "bash: gh: command not found")
                .contains("is not installed")
        );
        assert!(
            friendly_publish_error(Provider::GitLab, "sh: 1: glab: not found")
                .contains("is not installed")
        );
        assert!(friendly_publish_error(
            Provider::GitHub,
            "'gh' is not recognized as an internal or external command"
        )
        .contains("is not installed"));
    }

    #[test]
    fn friendly_error_flags_missing_auth() {
        let msg = friendly_publish_error(Provider::GitHub, "gh: not logged into any GitHub hosts");
        assert!(msg.contains("gh auth login"));
        assert!(msg.contains("not logged into any GitHub hosts"));
    }

    #[test]
    fn friendly_error_passes_through_unrecognized_failures() {
        let msg = friendly_publish_error(Provider::GitLab, "GraphQL: Name has already been taken");
        assert_eq!(msg, "GraphQL: Name has already been taken");
    }

    // ── Publish site (local mirror by default) ─────────────────────────────

    #[test]
    fn publish_from_defaults_to_the_local_mirror() {
        // Absent and empty both mean "this machine" — the hosting login is local.
        assert!(matches!(
            parse_publish_from(None),
            Ok(PublishSite::Local(_))
        ));
        assert!(matches!(
            parse_publish_from(Some("")),
            Ok(PublishSite::Local(_))
        ));
        assert!(matches!(
            parse_publish_from(Some("mirror")),
            Ok(PublishSite::Local(_))
        ));
    }

    #[test]
    fn publish_from_remote_opts_into_the_host() {
        assert_eq!(parse_publish_from(Some("remote")), Ok(PublishSite::Host));
        assert_eq!(parse_publish_from(Some("Host")), Ok(PublishSite::Host));
        assert!(parse_publish_from(Some("elsewhere")).is_err());
    }

    #[test]
    fn ssh_transport_failures_are_named_as_such() {
        for raw in [
            "Permission denied (publickey,password).",
            "ssh: connect to host h port 22: Connection refused",
            "ssh: Could not resolve hostname h: Name or service not known",
            "Host key verification failed.",
            "kex_exchange_identification: Connection closed by remote host",
        ] {
            let msg = ssh_transport_error(raw).expect("recognized as a transport failure");
            assert!(msg.contains("Could not reach the work-remote host"));
            // The original wording is kept — it is what a user greps for.
            assert!(msg.contains(raw.trim()));
        }
    }

    #[test]
    fn provider_failures_are_not_mistaken_for_transport_ones() {
        // "denied"/"not found" from the provider must fall through to the CLI
        // messages, or a real GitHub error would be reported as an SSH problem.
        assert!(ssh_transport_error("gh: Permission denied to fseiffarth.").is_none());
        assert!(ssh_transport_error("bash: gh: command not found").is_none());
        assert!(ssh_transport_error("GraphQL: Name has already been taken").is_none());
    }

    #[test]
    fn mirror_publish_is_refused_unless_lockstep_vouches_for_it() {
        // Lockstep off: the mirror is a real repo but nothing keeps it current, so
        // publishing it could ship a scaffold-only history under the project name.
        let msg = describe_mirror_guard(false, SyncStatus::Synchronized, None);
        assert!(msg.as_deref().unwrap().contains("lockstep is off"));

        // Out of step: name the reason, since the user can act on it.
        let msg = describe_mirror_guard(
            true,
            SyncStatus::Desynchronized,
            Some("the mirror is on 'main', the host is on 'claude'".to_string()),
        );
        let msg = msg.expect("desynchronized is refused");
        assert!(msg.contains("the host is on 'claude'"));

        // Cold pool: we cannot claim anything about the host, so we don't.
        assert!(describe_mirror_guard(true, SyncStatus::Disconnected, None).is_some());
        assert!(describe_mirror_guard(true, SyncStatus::Syncing, None).is_some());

        // Green is the one state that publishes.
        assert!(describe_mirror_guard(true, SyncStatus::Synchronized, None).is_none());
    }

    #[test]
    fn not_installed_error_names_cli_and_next_step() {
        let msg = not_installed_error(Provider::GitLab);
        assert!(msg.contains("glab"));
        assert!(msg.contains("glab auth login"));
        assert!(msg.contains("GitLab"));
    }

    /// Publish/visibility/unpublish act on the trusted entry: a `directory` or
    /// `remote` planted in the in-folder `project.json` must not redirect them.
    #[test]
    fn trusted_project_ignores_the_in_folder_copy() {
        let tmp = tempfile::tempdir().unwrap();
        let local_file = tmp.path().join("project.json");
        std::fs::write(
            &local_file,
            r#"{"id":"p","name":"evil","directory":"/home/u/other-private-repo",
                "git_type":"remote-public","git_provider":"gitlab",
                "remote":{"host":"attacker.example","remote_path":"/x"}}"#,
        )
        .unwrap();
        let entry = crate::schema::ProjectEntry {
            id: "p".into(),
            name: "Mine".into(),
            status: "active".into(),
            position: 0,
            local_file: local_file.to_string_lossy().into_owned(),
            extra: serde_json::from_value(serde_json::json!({
                "directory": "/home/u/mine",
                "git_type": "local",
            }))
            .unwrap(),
        };
        let p = trusted_project(&entry);
        assert_eq!(p.directory, "/home/u/mine");
        assert_eq!(p.name, "Mine");
        assert!(p.remote.is_none());
        assert_eq!(p.git_type.as_deref(), Some("local"));
        assert_eq!(p.git_provider, None);
    }
}

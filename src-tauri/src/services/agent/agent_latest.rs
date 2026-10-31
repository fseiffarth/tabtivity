//! The newest published release of each agent CLI, for Manage CLIs' "Check for
//! CLI updates" — the agent twin of the local-model update check.
//!
//! [`crate::services::agent_versions`] answers what is *installed* and never
//! reaches the network; this module answers what is *out there*, and only when
//! the user clicks. One GET per checked CLI, to the registry its vendor
//! publishes to: npm, PyPI, a GitHub release, or the vendor's own release
//! manifest. No token, no account, no
//! machine detail — the request names the app (GitHub refuses one without a
//! User-Agent) and nothing else.
//!
//! [`SOURCES`] is written down per CLI, not guessed from the install command: a
//! `curl … | bash` installer often fetches the same release that is published on
//! npm (Claude Code, Codex, OpenCode, Kilo), and only someone who compared the
//! two can say so. A CLI with no row is reported as "can't check", never as
//! current.
//!
//! The installed side is read where `agent_versions` has no recipe for it from
//! the package metadata next to the executable — npm's `package.json`, a Python
//! `*.dist-info` — so nothing is spawned.
//!
//! What a click found stays in `<state_dir>/agent_latest.json` ([`Store`]), so
//! the card still says it after the panel closes or the app restarts. Reading
//! that back never reaches the network.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::clock::now_secs;
use crate::services::agent_versions::{parse_version, version_cmp};

/// Where one CLI's releases are published.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    /// An npm package (`registry.npmjs.org/<pkg>/latest`).
    Npm(&'static str),
    /// A PyPI project (`pypi.org/pypi/<project>/json`).
    PyPi(&'static str),
    /// A GitHub repository's latest release (`owner/repo`).
    GitHub(&'static str),
    /// A vendor's own release host (`<base>/manifests/<platform>.json`), the
    /// file its native installer reads.
    Manifest(&'static str),
}

/// Per registry `id`. Each row was checked against the registry on 2026-10-02:
/// the package exists, ships the CLI's binary, and its version line is the one
/// the CLI prints.
pub const SOURCES: &[(&str, Source)] = &[
    // Native installer; the same build is published to npm.
    ("claude", Source::Npm("@anthropic-ai/claude-code")),
    ("codex", Source::Npm("@openai/codex")),
    ("gemini", Source::Npm("@google/gemini-cli")),
    ("cline", Source::Npm("cline")),
    ("vibe", Source::PyPi("mistral-vibe")),
    ("aider", Source::PyPi("aider-chat")),
    // OpenCode 2, which the V2 installer fetches (`opencode.ai/update/api/latest`
    // names this package) and its Windows installer is; `opencode-ai` is V1 only.
    ("opencode", Source::Npm("@opencode/cli")),
    ("copilot", Source::Npm("@github/copilot")),
    ("droid", Source::Npm("@factory/cli")),
    ("qwen", Source::Npm("@qwen-code/qwen-code")),
    ("openclaw", Source::Npm("openclaw")),
    ("auggie", Source::Npm("@augmentcode/auggie")),
    ("kilo", Source::Npm("@kilocode/cli")),
    ("continue", Source::Npm("@continuedev/cli")),
    ("codebuddy", Source::Npm("@tencent-ai/codebuddy-code")),
    ("goose", Source::GitHub("aaif-goose/goose")),
    ("pi", Source::Npm("@earendil-works/pi-coding-agent")),
    ("mini-swe-agent", Source::PyPi("mini-swe-agent")),
    ("crush", Source::Npm("@charmland/crush")),
    ("amp", Source::Npm("@ampcode/cli")),
    ("kimi", Source::PyPi("kimi-cli")),
    // On no public registry: this is the host and manifest `install.sh` and
    // `install.ps1` read, and every platform's named 1.4.11 on 2026-10-30.
    (
        "antigravity",
        Source::Manifest("https://antigravity-cli-auto-updater-974169037036.us-central1.run.app"),
    ),
];

pub fn source_for(agent_id: &str) -> Option<Source> {
    SOURCES
        .iter()
        .find(|(id, _)| *id == agent_id)
        .map(|(_, source)| *source)
}

/// How long one registry request may take.
const FETCH_TIMEOUT: Duration = Duration::from_secs(15);

/// Largest registry answer read. npm's `/latest` and GitHub's latest release are
/// a few KB; PyPI's project JSON lists every release and runs to a few hundred.
const MAX_BODY: usize = 4 * 1024 * 1024;

/// A manifest's platform name: `linux_amd64`, `darwin_arm64`, `windows_amd64`.
/// A musl Linux has its own build, but the same release number as this one.
fn manifest_platform(os: &str, arch: &str) -> String {
    let os = if os == "macos" { "darwin" } else { os };
    let arch = match arch {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        other => other,
    };
    format!("{os}_{arch}")
}

fn url_for(source: Source) -> String {
    match source {
        // A scoped name's slash is escaped, which the registry answers the same
        // way for every package shape.
        Source::Npm(pkg) => format!("https://registry.npmjs.org/{}/latest", pkg.replace('/', "%2f")),
        Source::PyPi(project) => format!("https://pypi.org/pypi/{project}/json"),
        Source::GitHub(repo) => format!("https://api.github.com/repos/{repo}/releases/latest"),
        Source::Manifest(base) => {
            let platform = manifest_platform(std::env::consts::OS, std::env::consts::ARCH);
            format!("{base}/manifests/{platform}.json")
        }
    }
}

/// The version inside one registry answer.
pub fn parse_latest(source: Source, body: &str) -> Option<String> {
    let json: serde_json::Value = serde_json::from_str(body).ok()?;
    let raw = match source {
        Source::Npm(_) | Source::Manifest(_) => json["version"].as_str()?,
        Source::PyPi(_) => json["info"]["version"].as_str()?,
        // `v1.53.0`, or a monorepo's `cli/v2.2.1`: the part after the last slash.
        Source::GitHub(_) => json["tag_name"].as_str()?.rsplit('/').next()?,
    };
    parse_version(raw)
}

/// A GitHub repository's latest-release *web* page, which redirects to
/// `…/releases/tag/<tag>`. Read before the REST API: unauthenticated, the API
/// allows 60 requests an hour per IP — shared by everything behind that address
/// — and once spent it answered 403 to every check (2026-10-02). The redirect
/// is not counted against that quota.
pub fn github_latest_page(repo: &str) -> String {
    format!("https://github.com/{repo}/releases/latest")
}

/// The tag a [`github_latest_page`] redirect points at, from its `Location`.
/// A monorepo tag (`cli/v2.2.1`, possibly `%2F`-escaped) yields its last part,
/// as [`parse_latest`] does for the API's `tag_name`.
pub fn tag_from_release_redirect(location: &str) -> Option<String> {
    let tag = location.split_once("/releases/tag/")?.1;
    let tag = tag.split(['?', '#']).next()?.replace("%2F", "/").replace("%2f", "/");
    let tag = tag.rsplit('/').next()?.trim();
    (!tag.is_empty()).then(|| tag.to_string())
}

fn client() -> Result<reqwest::Client, String> {
    client_with(reqwest::redirect::Policy::default())
}

fn client_with(redirect: reqwest::redirect::Policy) -> Result<reqwest::Client, String> {
    // `reqwest` is built with `rustls-no-provider`; see `app_update::client`.
    crate::services::mail_engine::install_crypto_provider();
    reqwest::Client::builder()
        .user_agent(crate::app_name!())
        .timeout(FETCH_TIMEOUT)
        .referer(false)
        .redirect(redirect)
        .build()
        .map_err(|e| format!("update-client: {e}"))
}

/// The newest release of a GitHub repository, from the release page's redirect
/// (no API quota). `Err` when GitHub answered anything but a redirect to a tag.
async fn github_latest_from_redirect(repo: &str) -> Result<String, String> {
    let response = client_with(reqwest::redirect::Policy::none())?
        .head(github_latest_page(repo))
        .send()
        .await
        .map_err(|e| format!("couldn't reach the registry: {}", e.without_url()))?;
    response
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .and_then(tag_from_release_redirect)
        .and_then(|tag| parse_version(&tag))
        .ok_or_else(|| format!("the release page answered {}", response.status()))
}

/// Ask `source`'s registry for its newest release.
pub async fn fetch_latest(source: Source) -> Result<String, String> {
    if let Source::GitHub(repo) = source {
        if let Ok(version) = github_latest_from_redirect(repo).await {
            return Ok(version);
        }
        // Fall through to the API, which still answers while its quota lasts.
    }
    let mut response = client()?
        .get(url_for(source))
        .header("Accept", "application/json")
        .send()
        .await
        // Display without the URL chain: the host is the whole message.
        .map_err(|e| format!("couldn't reach the registry: {}", e.without_url()))?;
    if !response.status().is_success() {
        return Err(format!("the registry answered {}", response.status()));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("registry answer cut off: {}", e.without_url()))?
    {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_BODY {
            return Err("the registry answer was too large".into());
        }
    }
    parse_latest(source, &String::from_utf8_lossy(&body))
        .ok_or_else(|| "the registry answer named no version".into())
}

/// How many directories above the executable are searched for its package.
/// npm's `lib/node_modules/<pkg>/bin/x` and a venv's `bin/x` are both within it.
const PACKAGE_DEPTH: usize = 5;

/// The installed version of `source`'s package, read from the metadata beside
/// the resolved executable `exe` (symlinks followed). `None` for a GitHub
/// release or a manifest, which install no metadata, or when nothing matching
/// is found.
pub fn installed_version_near(exe: &Path, source: Source) -> Option<String> {
    let real = exe.canonicalize().unwrap_or_else(|_| exe.to_path_buf());
    let mut starts = vec![real.clone()];
    if real != exe {
        starts.push(exe.to_path_buf());
    }
    starts.iter().find_map(|start| match source {
        Source::Npm(pkg) => npm_version_near(start, pkg),
        Source::PyPi(project) => dist_info_version_near(start, project),
        Source::GitHub(_) | Source::Manifest(_) => None,
    })
}

fn ancestors(start: &Path) -> impl Iterator<Item = &Path> {
    start.ancestors().skip(1).take(PACKAGE_DEPTH)
}

/// npm: the executable lives in the package (`…/node_modules/<pkg>/bin/x`), or
/// beside a prefix whose `lib/node_modules/<pkg>` holds it (a shim's copy, the
/// Windows `npm\x.cmd` layout).
fn npm_version_near(start: &Path, pkg: &str) -> Option<String> {
    let read = |manifest: PathBuf| -> Option<String> {
        let json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(manifest).ok()?).ok()?;
        if json["name"].as_str()? != pkg {
            return None;
        }
        parse_version(json["version"].as_str()?)
    };
    ancestors(start).find_map(|dir| {
        read(dir.join("package.json"))
            .or_else(|| read(dir.join("lib").join("node_modules").join(pkg).join("package.json")))
            .or_else(|| read(dir.join("node_modules").join(pkg).join("package.json")))
    })
}

/// PyPI's normalised project name as a `dist-info` directory spells it
/// (`aider-chat` → `aider_chat`).
fn dist_name(project: &str) -> String {
    project
        .chars()
        .map(|c| if c == '-' || c == '.' { '_' } else { c.to_ascii_lowercase() })
        .collect()
}

/// Python: a venv or user site beside the executable carries
/// `lib/python3.X/site-packages/<name>-<version>.dist-info` (on Windows
/// `Lib/site-packages`).
fn dist_info_version_near(start: &Path, project: &str) -> Option<String> {
    let want = dist_name(project);
    let in_site = |site: PathBuf| -> Option<String> {
        std::fs::read_dir(site).ok()?.flatten().find_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let stem = name.strip_suffix(".dist-info")?;
            let (dist, version) = stem.split_once('-')?;
            (dist_name(dist) == want).then(|| parse_version(version)).flatten()
        })
    };
    ancestors(start).find_map(|dir| {
        if let Some(found) = in_site(dir.join("Lib").join("site-packages")) {
            return Some(found);
        }
        std::fs::read_dir(dir.join("lib"))
            .ok()?
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with("python"))
            .find_map(|e| in_site(e.path().join("site-packages")))
    })
}

/// The version a card compares a release against: the CLI's `--version` answer,
/// else the package metadata beside `exe`.
pub fn current_version(agent_id: &str, exe: &Path, probed: Option<String>) -> Option<String> {
    probed.or_else(|| source_for(agent_id).and_then(|source| installed_version_near(exe, source)))
}

/// One CLI's last "Check for update". The installed side is left out on purpose:
/// it moves on its own, so [`UpdateReport::new`] compares at every read.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Checked {
    /// The newest release a check has seen. A failed check keeps it: an update
    /// is still out there when the registry is down.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest: Option<String>,
    /// Why the last check failed, when it did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Unix seconds of the last check.
    #[serde(default)]
    pub checked_at: u64,
}

/// `<state_dir>/agent_latest.json`, keyed by registry `id`. Deleting it costs
/// one click per card.
pub type Store = HashMap<String, Checked>;

pub fn store_path() -> PathBuf {
    crate::storage::state_dir().join("agent_latest.json")
}

/// A missing or unreadable file is an empty store, as for `agent_versions`.
pub fn load_in(path: &Path) -> Store {
    crate::storage::read_json(path).unwrap_or_default()
}

pub fn load() -> Store {
    load_in(&store_path())
}

fn checked_from(previous: Option<&Checked>, found: &Option<Result<String, String>>) -> Checked {
    let (latest, error) = match found {
        Some(Ok(version)) => (Some(version.clone()), None),
        Some(Err(error)) => (previous.and_then(|checked| checked.latest.clone()), Some(error.clone())),
        None => (None, None),
    };
    Checked { latest, error, checked_at: now_secs() }
}

/// Record one check (`None`: this CLI has no registry) and hand back what was
/// stored. A failed write costs one more click, so the answer is still returned.
pub fn remember_in(path: &Path, agent_id: &str, found: Option<Result<String, String>>) -> Checked {
    crate::storage::patch_json(path, Store::new(), |store| {
        let entry = checked_from(store.get(agent_id), &found);
        store.insert(agent_id.to_string(), entry.clone());
        Ok(entry)
    })
    .unwrap_or_else(|_| checked_from(None, &found))
}

pub fn remember(agent_id: &str, found: Option<Result<String, String>>) -> Checked {
    remember_in(&store_path(), agent_id, found)
}

/// One installed CLI against its newest published release.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateReport {
    pub agent: String,
    /// The installed version, when it could be read ([`current_version`]).
    pub current: Option<String>,
    /// The newest published version.
    pub latest: Option<String>,
    /// Both versions read and `latest` genuinely newer — never `latest` alone.
    pub update_available: bool,
    /// Whether a registry is known for this CLI at all.
    pub checkable: bool,
    pub error: Option<String>,
    /// Unix seconds of the check behind this answer.
    pub checked_at: u64,
}

impl UpdateReport {
    pub fn new(agent: &str, current: Option<String>, checked: &Checked) -> Self {
        let update_available = matches!(
            (&current, &checked.latest),
            (Some(current), Some(latest)) if version_cmp(latest, current) == std::cmp::Ordering::Greater
        );
        Self {
            agent: agent.to_string(),
            checkable: source_for(agent).is_some(),
            current,
            latest: checked.latest.clone(),
            update_available,
            error: checked.error.clone(),
            checked_at: checked.checked_at,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_each_registry_shape() {
        assert_eq!(
            parse_latest(Source::Npm("x"), r#"{"name":"x","version":"2.1.287"}"#).as_deref(),
            Some("2.1.287")
        );
        assert_eq!(
            parse_latest(Source::PyPi("x"), r#"{"info":{"version":"0.86.2"},"releases":{}}"#)
                .as_deref(),
            Some("0.86.2")
        );
        assert_eq!(
            parse_latest(Source::GitHub("o/r"), r#"{"tag_name":"v1.53.0"}"#).as_deref(),
            Some("1.53.0")
        );
        assert_eq!(
            parse_latest(Source::GitHub("o/r"), r#"{"tag_name":"cli/v2.2.1"}"#).as_deref(),
            Some("2.2.1")
        );
        assert_eq!(
            parse_latest(
                Source::Manifest("https://x"),
                r#"{"version":"1.4.11","url":"https://x/agy.tar.gz","sha512":"00"}"#
            )
            .as_deref(),
            Some("1.4.11")
        );
        assert_eq!(parse_latest(Source::Npm("x"), r#"{"error":"Not found"}"#), None);
        assert_eq!(parse_latest(Source::Npm("x"), "<html>"), None);
    }

    #[test]
    fn reads_the_tag_a_release_redirect_points_at() {
        assert_eq!(github_latest_page("o/r"), "https://github.com/o/r/releases/latest");
        assert_eq!(
            tag_from_release_redirect("https://github.com/ollama/ollama/releases/tag/v0.35.1")
                .as_deref(),
            Some("v0.35.1")
        );
        assert_eq!(
            tag_from_release_redirect("https://github.com/o/r/releases/tag/cli%2Fv2.2.1").as_deref(),
            Some("v2.2.1")
        );
        assert_eq!(
            tag_from_release_redirect("https://github.com/o/r/releases/tag/cli/v2.2.1").as_deref(),
            Some("v2.2.1")
        );
        // No release yet: GitHub sends the releases list, not a tag.
        assert_eq!(tag_from_release_redirect("https://github.com/o/r/releases"), None);
        assert_eq!(tag_from_release_redirect("https://github.com/o/r/releases/tag/"), None);
    }

    #[test]
    fn scoped_npm_names_are_escaped() {
        assert_eq!(
            url_for(Source::Npm("@openai/codex")),
            "https://registry.npmjs.org/@openai%2fcodex/latest"
        );
    }

    #[test]
    fn reads_the_npm_package_the_executable_belongs_to() {
        let tmp = tempfile::tempdir().unwrap();
        let pkg = tmp.path().join("lib/node_modules/@google/gemini-cli");
        std::fs::create_dir_all(pkg.join("bundle")).unwrap();
        std::fs::write(pkg.join("package.json"), r#"{"name":"@google/gemini-cli","version":"0.61.1"}"#)
            .unwrap();
        let exe = pkg.join("bundle/gemini.js");
        std::fs::write(&exe, "").unwrap();
        assert_eq!(
            installed_version_near(&exe, Source::Npm("@google/gemini-cli")).as_deref(),
            Some("0.61.1")
        );
        // Another package's manifest on the way up is not this one's version.
        assert_eq!(installed_version_near(&exe, Source::Npm("cline")), None);
    }

    #[cfg(unix)]
    #[test]
    fn follows_the_npm_bin_link() {
        let tmp = tempfile::tempdir().unwrap();
        let pkg = tmp.path().join("lib/node_modules/cline");
        std::fs::create_dir_all(pkg.join("bin")).unwrap();
        std::fs::write(pkg.join("package.json"), r#"{"name":"cline","version":"3.0.60"}"#).unwrap();
        std::fs::write(pkg.join("bin/cline"), "").unwrap();
        std::fs::create_dir_all(tmp.path().join("bin")).unwrap();
        let link = tmp.path().join("bin/cline");
        std::os::unix::fs::symlink(pkg.join("bin/cline"), &link).unwrap();
        assert_eq!(installed_version_near(&link, Source::Npm("cline")).as_deref(), Some("3.0.60"));
    }

    #[test]
    fn reads_a_venv_dist_info() {
        let tmp = tempfile::tempdir().unwrap();
        let tool = tmp.path().join("uv/tools/aider-chat");
        std::fs::create_dir_all(tool.join("bin")).unwrap();
        std::fs::create_dir_all(tool.join("lib/python3.12/site-packages/aider_chat-0.86.1.dist-info"))
            .unwrap();
        std::fs::create_dir_all(tool.join("lib/python3.12/site-packages/litellm-1.2.3.dist-info"))
            .unwrap();
        let exe = tool.join("bin/aider");
        std::fs::write(&exe, "").unwrap();
        assert_eq!(
            installed_version_near(&exe, Source::PyPi("aider-chat")).as_deref(),
            Some("0.86.1")
        );
        assert_eq!(installed_version_near(&exe, Source::PyPi("kimi-cli")), None);
    }

    #[test]
    fn a_github_release_has_no_local_metadata() {
        let tmp = tempfile::tempdir().unwrap();
        let exe = tmp.path().join("goose");
        std::fs::write(&exe, "").unwrap();
        assert_eq!(installed_version_near(&exe, Source::GitHub("o/r")), None);
        assert_eq!(installed_version_near(&exe, Source::Manifest("https://x")), None);
    }

    #[test]
    fn a_check_survives_in_the_store_until_the_next_one() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent_latest.json");
        assert!(load_in(&path).is_empty());

        let checked = remember_in(&path, "codex", Some(Ok("0.170.0".to_string())));
        assert_eq!(checked.latest.as_deref(), Some("0.170.0"));
        assert!(checked.checked_at > 0);
        assert_eq!(load_in(&path).get("codex"), Some(&checked));

        remember_in(&path, "kimi", Some(Ok("1.2.0".to_string())));
        assert_eq!(load_in(&path).len(), 2, "one CLI's check leaves the others'");
    }

    #[test]
    fn a_failed_check_keeps_the_known_release_until_one_succeeds() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent_latest.json");
        remember_in(&path, "codex", Some(Ok("0.170.0".to_string())));

        let failed = remember_in(&path, "codex", Some(Err("registry down".to_string())));
        assert_eq!(failed.latest.as_deref(), Some("0.170.0"));
        assert_eq!(failed.error.as_deref(), Some("registry down"));

        let again = remember_in(&path, "codex", Some(Ok("0.171.0".to_string())));
        assert_eq!(again.latest.as_deref(), Some("0.171.0"));
        assert_eq!(again.error, None);
    }

    #[test]
    fn a_stored_release_is_judged_against_what_is_installed_now() {
        let checked = Checked { latest: Some("0.170.0".to_string()), error: None, checked_at: 7 };

        let behind = UpdateReport::new("codex", Some("0.169.0".to_string()), &checked);
        assert!(behind.update_available);
        assert!(behind.checkable);
        assert_eq!(behind.checked_at, 7);

        // The CLI updated itself after the check: not offered what it already has.
        let caught_up = UpdateReport::new("codex", Some("0.170.0".to_string()), &checked);
        assert!(!caught_up.update_available);
        let past = UpdateReport::new("codex", Some("0.171.0".to_string()), &checked);
        assert!(!past.update_available);

        assert!(!UpdateReport::new("codex", None, &checked).update_available);
    }

    #[test]
    fn a_cli_with_no_registry_is_remembered_as_uncheckable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent_latest.json");
        let checked = remember_in(&path, "no-such-cli", None);
        let report = UpdateReport::new("no-such-cli", Some("1.0.0".to_string()), &checked);
        assert_eq!((report.latest, report.checkable), (None, false));
        assert!(load_in(&path).contains_key("no-such-cli"));
    }

    #[test]
    fn an_unreadable_store_loses_nothing_but_the_stored_answer() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent_latest.json");
        std::fs::write(&path, "not json").unwrap();
        assert!(load_in(&path).is_empty());
        let checked = remember_in(&path, "codex", Some(Ok("0.170.0".to_string())));
        assert_eq!(checked.latest.as_deref(), Some("0.170.0"));
    }

    #[test]
    fn the_installed_version_prefers_the_probe_over_package_metadata() {
        let tmp = tempfile::tempdir().unwrap();
        let exe = tmp.path().join("codex");
        assert_eq!(
            current_version("codex", &exe, Some("0.170.0".to_string())).as_deref(),
            Some("0.170.0")
        );
        assert_eq!(current_version("codex", &exe, None), None);
    }
}

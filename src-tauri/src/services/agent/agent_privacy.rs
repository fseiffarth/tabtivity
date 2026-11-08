//! Local-models-only projects (`docs/local_models_only_plan.md`, phase 1,
//! `docs/context/local_models_only.md`).
//!
//! A project marked **Local models only** (`agent_privacy.local_models_only` on
//! its trusted `projects.json` entry, never the in-folder `project.json`) is
//! read by no cloud model: the only agent that starts in it is one on an
//! installed local Ollama model, and the fence of every other tab hides its
//! folder. This module holds the pieces, all `AppHandle`-free:
//!
//! - the setting ([`Privacy`], [`check_enable`], [`set`]);
//! - the spawn gate ([`gate`], run first thing in `launch_prep::prepare`; and
//!   [`fence_gate`], run again by both fence wrappers, which every spawn of an
//!   agent on Linux and macOS passes, the `agent_shim` of a shell tab included);
//! - the masks other fences carry ([`mask_dirs`]);
//! - the environment a verified tab runs with ([`PROVIDER_ENV`], [`unset_names`]).
//!
//! The gate never trusts the renderer. A launch is local only when its own argv
//! is one of the lines Tabtivity builds for a local driver
//! (`local_drivers::identify_local_launch`), or a `vibe` tab whose model is
//! named by env the backend then writes a config for itself; the model must be
//! one the loopback Ollama lists without a remote
//! (`ollama_client::tab_model_is_local_at`, the check a mail read passes), and
//! `PtyOptions.local_model`, which only picks a home, counts for nothing. Every
//! doubt refuses.
//!
//! What the mode does **not** cover is in [`LIMITS`] and the context doc: the
//! network of a local agent, and shell tabs, the Host session and Windows,
//! which no fence reaches.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use app_core::sync::LockExt;
use serde_json::{Map, Value};

use crate::schema::boxes::BoxesList;
use crate::schema::projects::{ProjectEntry, ProjectsList};
use crate::terminal::PtyOptions;

/// The `projects.json` key: `{ "local_models_only": bool, "cut_network": bool }`.
pub const KEY: &str = "agent_privacy";

/// What every refusal of this module starts with, for the frontend to place a
/// failed spawn (the text after it names the project and the switch).
pub const REFUSAL: &str = "Local models only";

/// The env variable [`gate`] stamps on a spawn it verified, with the id of the
/// project it verified it for. A control variable (`launch_prep::is_control_env`):
/// a tab never brings one, `prepare` drops it before the gate runs.
pub const STAMP_ENV: &str = crate::app_env!("LOCAL_MODELS_ONLY");

/// Why Cut network cannot be switched on yet (phase 2 of the plan): stored in
/// the setting's shape, shown in the UI, refused here rather than accepted
/// without a guarantee.
pub const CUT_NETWORK_UNAVAILABLE: &str =
    "Cut network is not available yet: the network cut and the relay to the local model are not built, so switching it on would promise something nothing enforces.";

/// The limits of the mode, in the words the UI help and the context doc use.
pub const LIMITS: &str = "A local agent keeps its own network unless Cut network is on, so a fetch tool, a prompt-injected curl or a git push can still send what it read. Shell tabs, the root console's Host session and Windows have no fence that hides the folder.";

/// The setting of one project.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct Privacy {
    pub local_models_only: bool,
    pub cut_network: bool,
}

/// The setting `entry` carries. Absent (or `null`) is off; a value of any other
/// shape than the one [`set`] writes reads as on, so a hand-edited or damaged
/// record narrows rather than opens.
pub fn privacy_of(entry: &ProjectEntry) -> Privacy {
    let on = |v: Option<&Value>| !matches!(v, None | Some(Value::Null) | Some(Value::Bool(false)));
    match entry.extra.get(KEY) {
        None | Some(Value::Null) => Privacy::default(),
        Some(Value::Object(map)) => {
            Privacy { local_models_only: on(map.get("local_models_only")), cut_network: on(map.get("cut_network")) }
        }
        Some(_) => Privacy { local_models_only: true, cut_network: false },
    }
}

/// A local-models-only project, as the fences and the gate see it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Locked {
    pub id: String,
    pub name: String,
    /// The project's folder; `None` when its record names none (then every
    /// spawn of it is refused already: no root).
    pub dir: Option<PathBuf>,
    pub cut_network: bool,
}

/// Every local-models-only project in `projects`.
pub fn locked_projects(projects: &ProjectsList) -> Vec<Locked> {
    projects
        .iter()
        .filter_map(|p| {
            let privacy = privacy_of(p);
            privacy.local_models_only.then(|| Locked {
                id: p.id.clone(),
                name: p.name.clone(),
                dir: p.directory().map(PathBuf::from),
                cut_network: privacy.cut_network,
            })
        })
        .collect()
}

/// [`locked_projects`] of the live registry; unreadable is an error, never
/// "none locked".
pub fn locked_now() -> Result<Vec<Locked>, String> {
    let projects = crate::services::remote::projects().map_err(|e| format!("{REFUSAL}: the project list could not be read ({e}), so no agent was started."))?;
    Ok(locked_projects(&projects))
}

/// The project ids whose folders `projects` marks local-models-only.
pub fn locked_ids(projects: &ProjectsList) -> Vec<String> {
    locked_projects(projects).into_iter().map(|l| l.id).collect()
}

/// Whether `entry` is a local-models-only project.
pub fn is_locked(entry: &ProjectEntry) -> bool {
    privacy_of(entry).local_models_only
}

/// `path` with `.` and `..` folded away lexically.
fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Whether `path` is `dir` or lies below it, by the spelling given, with its
/// `..` folded, and by what each resolves to (a link inside another project
/// can lead here). Any of the three counts: a doubt means inside.
pub fn path_inside(path: &Path, dir: &Path) -> bool {
    if path.as_os_str().is_empty() || dir.as_os_str().is_empty() {
        return false;
    }
    if path.starts_with(dir) || lexical(path).starts_with(lexical(dir)) {
        return true;
    }
    let real = path.ancestors().find_map(|a| a.canonicalize().ok());
    match (real, dir.canonicalize()) {
        (Some(real), Ok(root)) => real.starts_with(root),
        _ => false,
    }
}

/// The locked projects a spawn is subject to: the one it runs in, and any whose
/// folder its `cwd` lies in (the root console's Host session, a box tab).
pub fn subjects<'a>(locked: &'a [Locked], project_id: Option<&str>, cwd: &str) -> Vec<&'a Locked> {
    locked
        .iter()
        .filter(|l| project_id == Some(l.id.as_str()) || l.dir.as_deref().is_some_and(|dir| path_inside(Path::new(cwd), dir)))
        .collect()
}

/// The folders a fence hides: every local-models-only project's, but the
/// scope's own (`own`: the project a tab of that project runs in), with the
/// resolved spelling of each beside the given one. Only folders that exist: a
/// mount over nothing fails the fence. Linux splices `--tmpfs` over them last
/// (`agent_fence::mask_local_models_only`); macOS denies them in the profile.
pub fn mask_dirs(locked: &[Locked], own: Option<&str>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for l in locked.iter().filter(|l| Some(l.id.as_str()) != own) {
        let Some(dir) = l.dir.as_deref().filter(|d| d.is_absolute() && d.is_dir()) else { continue };
        for path in [Some(dir.to_path_buf()), dir.canonicalize().ok()].into_iter().flatten() {
            if !out.contains(&path) {
                out.push(path);
            }
        }
    }
    out
}

/// [`mask_dirs`] against the live registry. A registry that cannot be read
/// masks nothing — the spawn that needs it was refused at the gate already, and
/// a fence with no project list builds no roots either.
pub fn mask_dirs_now(own: Option<&str>) -> Vec<PathBuf> {
    match crate::services::remote::projects() {
        Ok(projects) => mask_dirs(&locked_projects(&projects), own),
        Err(_) => Vec::new(),
    }
}

// ── The environment of a verified tab ───────────────────────────────────────

/// Variables that carry a provider's key or point a CLI at a provider: removed
/// from a verified tab's environment, the inherited ones by the fence
/// (`--unsetenv`) and the PTY (`env_remove`). The fence does not filter env,
/// and `vibe` falls back to its cloud default when its config is missing.
pub const PROVIDER_ENV: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_API_BASE",
    "OPENAI_ORG_ID",
    "CODEX_API_KEY",
    "MISTRAL_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "OPENROUTER_API_KEY",
    "GROQ_API_KEY",
    "XAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "TOGETHER_API_KEY",
    "FIREWORKS_API_KEY",
    "COHERE_API_KEY",
    "PERPLEXITY_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "OLLAMA_API_KEY",
    "COPILOT_GITHUB_TOKEN",
];

/// Variables a tab brings itself that would re-aim a local line at a provider
/// the gate did not look at (the inline OpenCode config is Tabtivity's own,
/// added after the gate); dropped from the renderer's env, not from the
/// inherited one.
const RETARGET_ENV: &[&str] = &["OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "VIBE_MCP_SERVERS"];

/// Whether `name` is a provider key or endpoint variable ([`PROVIDER_ENV`], or
/// any `*_API_KEY` / `*_API_TOKEN` / `*_AUTH_TOKEN` in any letter case: Windows
/// folds them).
pub fn is_provider_env(name: &str) -> bool {
    let up = name.to_ascii_uppercase();
    PROVIDER_ENV.contains(&up.as_str())
        || ["_API_KEY", "_API_TOKEN", "_AUTH_TOKEN"].iter().any(|suffix| up.ends_with(suffix))
}

/// The names to unset in a verified tab's fence: [`PROVIDER_ENV`] and every
/// provider-looking variable `env` or this process's own environment holds.
pub fn unset_names<'a>(env: impl IntoIterator<Item = &'a String>) -> Vec<String> {
    let mut names: Vec<String> = PROVIDER_ENV.iter().map(|s| s.to_string()).collect();
    names.extend(env.into_iter().filter(|k| is_provider_env(k)).cloned());
    names.extend(std::env::vars_os().filter_map(|(k, _)| k.into_string().ok()).filter(|k| is_provider_env(k)));
    names.sort();
    names.dedup();
    names
}

/// Drop what the renderer put in a verified tab's `env`: provider keys,
/// endpoints, and config overrides ([`PROVIDER_ENV`], [`RETARGET_ENV`]).
fn scrub_env(env: &mut HashMap<String, String>) {
    env.retain(|k, _| {
        let up = k.to_ascii_uppercase();
        !is_provider_env(k) && !RETARGET_ENV.contains(&up.as_str())
    });
}

// ── The refusals ────────────────────────────────────────────────────────────

fn refuse(project: &Locked, why: &str) -> String {
    format!(
        "{REFUSAL}: \"{}\" is set to Local models only, so {why} Switch it off in the project's menu to start this agent.",
        project.name
    )
}

/// The name of the program in `cmd`, for messages.
fn program(cmd: &str) -> String {
    Path::new(cmd).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| cmd.to_string())
}

// ── The spawn gate ──────────────────────────────────────────────────────────

/// A spawn the gate verified.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Verified {
    pub project: String,
    /// The local driver's id, or `"vibe"`.
    pub driver: String,
    pub model: String,
    /// The loopback `host:port` the model was judged on.
    pub endpoint: String,
}

/// What the gate asks of the machine, so the rule is a test and not a claim.
pub struct Probe<'a> {
    /// The loopback Ollama address, or why there is none
    /// (`mail_ai::resolve_endpoint` over `ollama_host`: a remote host is
    /// refused even with `ollama_allow_remote_host` on).
    pub endpoint: &'a dyn Fn() -> Result<String, String>,
    /// `ollama_client::tab_model_is_local_at`: the verdict for `(addr, model)`.
    pub local: &'a dyn Fn(&str, &str) -> Result<(), &'static str>,
    /// `OLLAMA_HOST` of this process, which a CLI started without one inherits.
    pub ambient_host: Option<String>,
}

/// The args of a local `vibe` tab Tabtivity starts: none, `--continue`, or
/// `--resume <session id>`.
fn vibe_args_ok(args: &[String]) -> bool {
    match args {
        [] => true,
        [flag] => flag == "--continue",
        [flag, id] => flag == "--resume" && crate::services::agent_session::is_uuid_shaped(id),
        _ => false,
    }
}

/// The model a local `vibe` spawn names in its env (`<APP>_LOCAL_MODEL`, with
/// `VIBE_ACTIVE_MODEL` as the alias of the same model), or why it names none.
fn vibe_model(opts: &PtyOptions) -> Result<String, &'static str> {
    let raw = opts.env.get(crate::app_env!("LOCAL_MODEL")).map(|m| m.trim()).filter(|m| !m.is_empty());
    let raw = raw.ok_or("this Mistral (vibe) tab does not name a local model.")?;
    if !crate::services::local_drivers::model_name_ok(raw) {
        return Err("this tab names a model that is not a plain Ollama model name.");
    }
    match opts.env.get("VIBE_ACTIVE_MODEL").map(|a| a.trim()).filter(|a| !a.is_empty()) {
        Some(alias) if alias != crate::services::ollama_client::sanitize_alias(raw) => {
            Err("this Mistral (vibe) tab's model and its alias disagree.")
        }
        _ => Ok(raw.to_string()),
    }
}

/// Decide one agent spawn that runs in, or with its working directory in, the
/// locked project `subject`. Pure over `probe`; nothing is changed.
fn vet(opts: &PtyOptions, subject: &Locked, probe: &Probe<'_>, remote_project: bool) -> Result<Verified, String> {
    let no = |why: &str| Err(refuse(subject, why));
    if subject.cut_network {
        return no("it is set to Cut network, which is not available yet (nothing enforces it), so the project is closed to agents until that switch is off.");
    }
    if opts.sandbox || opts.remote_host_id.as_deref().is_some_and(|h| h != crate::services::remote::PRIMARY_HOST) || remote_project {
        return no("it is not a plain local folder: remote, VM and container projects are not supported by this mode yet.");
    }
    if opts.host_session {
        return no("the root console's Host session is a cloud agent with your full rights.");
    }
    if opts.assistant.is_some() {
        return no("the chat assistant does not start in a project.");
    }
    let (driver, model) = if opts.cmd == "vibe" {
        if !vibe_args_ok(&opts.args) {
            return no("only a plain Mistral (vibe) local-model launch is allowed.");
        }
        ("vibe".to_string(), vibe_model(opts).map_err(|why| refuse(subject, why))?)
    } else if let Some((driver, model)) = crate::services::local_drivers::identify_local_launch(&opts.cmd, &opts.args) {
        (driver.to_string(), model)
    } else {
        return no(&format!(
            "only an agent on a local Ollama model may start here, and `{}` is not one of the launch lines the \u{ff0b} menu builds for a local model.",
            program(&opts.cmd)
        ));
    };
    if let Some(host) = &probe.ambient_host {
        if crate::services::ollama_client::resolve_ollama_addr(Some(host), true)
            .ok()
            .and_then(|addr| crate::services::ollama_client::split_host_port(&addr).map(|(h, _)| h.to_string()))
            .is_none_or(|h| !crate::services::ollama_client::host_is_loopback(&h))
        {
            return no("OLLAMA_HOST in your environment does not name this machine.");
        }
    }
    let endpoint = (probe.endpoint)().map_err(|e| refuse(subject, &format!("the Ollama host is not on this machine ({e}).")))?;
    (probe.local)(&endpoint, &model).map_err(|verdict| {
        refuse(
            subject,
            &match verdict {
                crate::services::ollama_client::MODEL_NOT_RUNNING => "Ollama is not running; start it and open the tab again.".to_string(),
                crate::services::ollama_client::LISTENER_REFUSED => "the listener on the Ollama port is not Ollama's.".to_string(),
                "model_not_local" => format!("`{model}` is an Ollama cloud model: it runs on ollama.com, not on this machine."),
                crate::services::ollama_client::MODEL_ALIAS_SHARED => format!("another installed model shares the name of `{model}`."),
                _ => format!("`{model}` is not a model the local Ollama lists as installed."),
            },
        )
    })?;
    Ok(Verified { project: subject.id.clone(), driver, model, endpoint })
}

/// The Mistral (`vibe`) home of `project` for `alias`: apart from the shared
/// `vibe_local/<alias>` of every other scope, so its logs and history never mix
/// with another scope's (`agent_authority.md`, gap 30).
pub fn vibe_home_in(share_dir: &Path, alias: &str, project: &str) -> PathBuf {
    share_dir.join("vibe_local").join(format!("{alias}.{}", crate::storage::project_key(project)))
}

/// Change a verified spawn's options to what the gate stands behind.
fn apply(opts: &mut PtyOptions, v: &Verified, share_dir: &Path) -> Result<(), String> {
    scrub_env(&mut opts.env);
    // Only picks the home without logins; the gate alone grants.
    opts.local_model = true;
    opts.env.insert(STAMP_ENV.to_string(), v.project.clone());
    opts.env.insert("OLLAMA_HOST".to_string(), v.endpoint.clone());
    if v.driver == "vibe" {
        let alias = crate::services::ollama_client::sanitize_alias(&v.model);
        let home = vibe_home_in(share_dir, &alias, &v.project);
        write_vibe_home(&home, &v.model, &alias, &v.endpoint)?;
        opts.env.insert("VIBE_HOME".to_string(), home.to_string_lossy().into_owned());
        opts.env.insert("VIBE_ACTIVE_MODEL".to_string(), alias);
    }
    Ok(())
}

/// Create `home` and write the one config it needs: the verified model on the
/// verified endpoint, written here and not by the renderer's own
/// `prepare_local_agent` call, so what runs is what was checked.
fn write_vibe_home(home: &Path, model: &str, alias: &str, endpoint: &str) -> Result<(), String> {
    let fail = |e: std::io::Error| format!("{REFUSAL}: could not prepare the Mistral home ({e}), so this agent was not started.");
    if let Some(parent) = home.parent() {
        std::fs::create_dir_all(parent).map_err(fail)?;
    }
    crate::services::agent_home::create_private_dir(home).map_err(fail)?;
    let config = home.join("config.toml");
    // A link planted there is replaced, never written through.
    if std::fs::symlink_metadata(&config).is_ok_and(|m| !m.file_type().is_file()) {
        let _ = std::fs::remove_file(&config);
    }
    std::fs::write(&config, crate::services::local_drivers::vibe_local_config(model, alias, endpoint)).map_err(fail)
}

/// The gate over given lists; [`gate`] is this against the live state.
pub fn gate_with(
    mut opts: PtyOptions,
    projects: &ProjectsList,
    probe: &Probe<'_>,
    share_dir: &Path,
) -> Result<PtyOptions, String> {
    if !crate::services::agent_fence::is_agent(&opts) {
        return Ok(opts);
    }
    let locked = locked_projects(projects);
    let hit = subjects(&locked, opts.project_id.as_deref(), &opts.cwd);
    forget(&opts.id);
    let Some(subject) = hit.first().copied() else { return Ok(opts) };
    if hit.len() > 1 {
        return Err(refuse(subject, "this agent would work in more than one local-models-only project."));
    }
    let remote = projects.iter().find(|p| p.id == subject.id).is_some_and(|p| p.extra.contains_key("remote") || p.extra.contains_key("vm"));
    let verified = vet(&opts, subject, probe, remote)?;
    apply(&mut opts, &verified, share_dir)?;
    note_verified(&opts.id, &verified.project);
    Ok(opts)
}

/// The spawn gate, first thing in `launch_prep::prepare` (blocking: it asks the
/// local Ollama). An agent outside every local-models-only project is returned
/// untouched; one inside is returned as a verified local launch or refused.
pub fn gate(opts: PtyOptions) -> Result<PtyOptions, String> {
    if !crate::services::agent_fence::is_agent(&opts) {
        return Ok(opts);
    }
    let projects = crate::services::remote::projects()
        .map_err(|e| format!("{REFUSAL}: the project list could not be read ({e}), so this agent was not started."))?;
    let settings = crate::storage::load_settings().unwrap_or_default();
    let host = crate::services::ollama_client::host_setting(&settings).0.map(str::to_string);
    let endpoint = move || crate::services::mail_ai::resolve_endpoint(host.as_deref());
    let local = |addr: &str, model: &str| crate::services::ollama_client::tab_model_is_local_at(addr, model);
    let probe = Probe { endpoint: &endpoint, local: &local, ambient_host: std::env::var("OLLAMA_HOST").ok().filter(|h| !h.trim().is_empty()) };
    gate_with(opts, &projects, &probe, &crate::storage::home_share_dir())
}

/// Whether `opts` carries the gate's stamp: a spawn that went through [`gate`].
pub fn stamped(opts: &PtyOptions) -> bool {
    opts.env.contains_key(STAMP_ENV)
}

/// The check both fence wrappers repeat (the argv was rewritten since the
/// gate, so the stamp is what is checked): a spawn subject to a locked project
/// must carry the stamp the gate left for exactly that project. Spawns that
/// reach a wrapper without `prepare` (the shell-tab shim) have none and are
/// refused. Returns the project the stamp is for, `None` for a spawn no locked
/// project touches.
pub fn fence_gate_in(locked: &[Locked], opts: &PtyOptions, scope_id: &str) -> Result<Option<String>, String> {
    let project = (scope_id != crate::storage::ROOT_SCOPE).then_some(scope_id);
    let hit = subjects(locked, project, &opts.cwd);
    let Some(subject) = hit.first().copied() else { return Ok(None) };
    let stamp = opts.env.get(STAMP_ENV);
    if hit.len() == 1 && stamp.is_some_and(|s| *s == subject.id) {
        return Ok(Some(subject.id.clone()));
    }
    Err(refuse(
        subject,
        &format!("`{}` was not started as a local-model tab. Open a local model from the \u{ff0b} menu.", program(&opts.cmd)),
    ))
}

/// [`fence_gate_in`] against the live registry; an unreadable registry refuses
/// (the assistant scope has no project and is never asked).
pub fn fence_gate(opts: &PtyOptions, scope_id: &str) -> Result<Option<String>, String> {
    if crate::storage::is_assistant_scope(scope_id) {
        return Ok(None);
    }
    fence_gate_in(&locked_now()?, opts, scope_id)
}

/// Why an agent may not start in the container of `project_id` (mounting
/// `project_dir`): the project is locked itself, or a locked project's folder
/// lies inside the mount, which a container cannot hide. `None` when neither.
/// An unreadable registry refuses.
pub fn container_refusal(project_id: &str, project_dir: Option<&str>) -> Option<String> {
    let locked = match locked_now() {
        Ok(locked) => locked,
        Err(e) => return Some(e),
    };
    container_refusal_in(&locked, project_id, project_dir)
}

/// [`container_refusal`] over a given list.
pub fn container_refusal_in(locked: &[Locked], project_id: &str, project_dir: Option<&str>) -> Option<String> {
    locked.iter().find_map(|l| {
        let own = l.id == project_id;
        let inside = project_dir.is_some_and(|dir| l.dir.as_deref().is_some_and(|d| path_inside(d, Path::new(dir))));
        (own || inside).then(|| {
            refuse(
                l,
                if own {
                    "container projects are not supported by this mode yet."
                } else {
                    "its folder lies inside this project's container mount, which cannot hide it from a cloud agent."
                },
            )
        })
    })
}

/// The code a drop is refused with (`terminalDrop.ts` maps it to a message).
pub const DROP_REFUSED: &str = "local_models_only";

/// Whether dropping `paths` onto the agent tab `tab` must be refused: some path
/// lies in a locked project's folder and the tab is not a local launch the gate
/// verified for that project. A file handed to a cloud agent is a file read by
/// one (the drop copies it into the tab's inbox). Inbound drops are fine.
pub fn drop_refused_in(locked: &[Locked], tab: &str, paths: &[String]) -> bool {
    locked.iter().any(|l| {
        l.dir.as_deref().is_some_and(|dir| paths.iter().any(|p| path_inside(Path::new(p), dir))) && !is_verified(tab, &l.id)
    })
}

/// [`drop_refused_in`] against the live registry; an unreadable one refuses.
pub fn drop_refused(tab: &str, paths: &[String]) -> bool {
    locked_now().map_or(true, |locked| drop_refused_in(&locked, tab, paths))
}

// ── Which tabs the gate verified ────────────────────────────────────────────

fn verified_tabs() -> &'static Mutex<HashMap<String, String>> {
    static TABS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    TABS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn note_verified(tab: &str, project: &str) {
    verified_tabs().lock_ok().insert(tab.to_string(), project.to_string());
}

/// Forget `tab` (it spawns again, or is gone).
pub fn forget(tab: &str) {
    verified_tabs().lock_ok().remove(tab);
}

/// Whether the gate verified the live spawn of `tab` for `project`.
pub fn is_verified(tab: &str, project: &str) -> bool {
    verified_tabs().lock_ok().get(tab).is_some_and(|p| p == project)
}

/// The tabs of `project` the gate verified.
pub fn verified_of(project: &str) -> Vec<String> {
    verified_tabs().lock_ok().iter().filter(|(_, p)| *p == project).map(|(t, _)| t.clone()).collect()
}

// ── The setting ─────────────────────────────────────────────────────────────

fn nested_in(dir: &Path, other: &Path) -> bool {
    path_inside(other, dir)
}

/// Whether `id` may be marked local-models-only now; the reason it may not
/// otherwise, naming the project. Pure over the lists and the endpoint check.
pub fn check_enable(
    projects: &ProjectsList,
    boxes: &BoxesList,
    id: &str,
    endpoint: Result<String, String>,
) -> Result<(), String> {
    let entry = projects.iter().find(|p| p.id == id).ok_or_else(|| format!("project '{id}' not found"))?;
    let no = |why: &str| Err(format!("\"{}\" cannot be set to Local models only: {why}", entry.name));
    if entry.extra.get("remote").is_some_and(|v| !v.is_null()) || entry.extra.get("vm").is_some_and(|v| !v.is_null()) {
        return no("it is a remote or VM project. This mode covers local folders only for now.");
    }
    if entry.extra.get("sandbox").and_then(|s| s.get("enabled")).and_then(Value::as_bool) == Some(true) {
        return no("its container is switched on. Container projects are not supported by this mode yet; switch the container off first.");
    }
    let Some(dir) = entry.directory().map(PathBuf::from) else {
        return no("its record names no folder.");
    };
    if let Some(inner) = projects.iter().filter(|p| p.id != id).find(|p| {
        [p.directory().map(PathBuf::from), p.extra.get("mirror").and_then(Value::as_str).map(PathBuf::from)]
            .into_iter()
            .flatten()
            .any(|other| nested_in(&dir, &other))
    }) {
        return no(&format!(
            "the project \"{}\" lies inside its folder, and a local tab here would write into a folder that project's cloud agents read.",
            inner.name
        ));
    }
    if let Some(b) = boxes.iter().find(|b| b.folder.as_deref().is_some_and(|f| nested_in(&dir, Path::new(f)))) {
        return no(&format!("the folder of the box \"{}\" lies inside it.", b.name));
    }
    if let Err(e) = endpoint {
        return no(&format!("the Ollama host is not on this machine ({e}). Point ollama_host at 127.0.0.1."));
    }
    Ok(())
}

/// Write `want` to project `id`'s trusted record. Turning Local models only on
/// is checked ([`check_enable`]); Cut network is stored in the setting's shape
/// but refused until it is enforced ([`CUT_NETWORK_UNAVAILABLE`]) and cannot be
/// on without Local models only. Unknown fields of the record round-trip, and
/// two off switches leave no record at all.
pub fn set(id: &str, want: Privacy) -> Result<Privacy, String> {
    if want.cut_network {
        return Err(CUT_NETWORK_UNAVAILABLE.to_string());
    }
    if want.local_models_only {
        let projects = crate::services::remote::projects()?;
        let boxes = crate::services::box_store::read_boxes()?;
        let settings = crate::storage::load_settings().unwrap_or_default();
        let endpoint = crate::services::mail_ai::resolve_endpoint(crate::services::ollama_client::host_setting(&settings).0);
        check_enable(&projects, &boxes, id, endpoint)?;
    }
    crate::services::project_registry::patch_project_entry(id, |entry| {
        write_privacy(&mut entry.extra, want);
        Ok(())
    })?;
    Ok(want)
}

/// [`set`]'s record edit: both fields written into the existing object, or the
/// key removed when nothing is on and nothing unknown is kept.
fn write_privacy(extra: &mut HashMap<String, Value>, want: Privacy) {
    let mut map: Map<String, Value> = match extra.remove(KEY) {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    map.insert("local_models_only".into(), Value::Bool(want.local_models_only));
    map.insert("cut_network".into(), Value::Bool(want.cut_network));
    if !want.local_models_only && !want.cut_network && map.len() == 2 {
        return;
    }
    extra.insert(KEY.to_string(), Value::Object(map));
}

#[cfg(test)]
mod tests;

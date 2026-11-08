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

/// [`mask_dirs`] against the live registry. A registry that cannot be read is an
/// error and the fence is not built: a fence with no masks would hand a locked
/// project's folder to whatever else is bound over it.
pub fn mask_dirs_now(own: Option<&str>) -> Result<Vec<PathBuf>, String> {
    mask_dirs_from(crate::services::remote::projects().map(|p| p.to_vec()), own)
}

/// [`mask_dirs_now`] over a given read of the registry.
pub fn mask_dirs_from(projects: Result<ProjectsList, String>, own: Option<&str>) -> Result<Vec<PathBuf>, String> {
    let projects = projects.map_err(|e| format!("{REFUSAL}: the project list could not be read ({e}), so no sandbox was built."))?;
    Ok(mask_dirs(&locked_projects(&projects), own))
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

/// The only variables a verified tab keeps of the ones it arrived with: the
/// frontend's own two (`<APP>_TAB_UID`, `<APP>_LOCAL_MODEL`, the label the usage
/// recap and the vibe gate read). Everything else a local launch needs is set by
/// the backend ([`apply`], `launch_prep`). The rest is dropped rather than listed
/// because a CLI reads more of its environment than any list of base URLs and
/// keys covers: Mistral's `vibe` takes every `VIBE_*` variable as a config field
/// (`VIBE_PROVIDERS`, `VIBE_MODELS` re-aim the verified model at a cloud
/// endpoint), Codex's `--oss` reads `CODEX_OSS_BASE_URL`, and the next CLI will
/// read another.
fn renderer_env_kept(name: &str) -> bool {
    let up = name.to_ascii_uppercase();
    [crate::app_env!("TAB_UID"), crate::app_env!("LOCAL_MODEL")].contains(&up.as_str())
}

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

/// Drop what the renderer put in a verified tab's `env`: everything but
/// [`renderer_env_kept`] (so provider keys, endpoints and config overrides go,
/// listed or not).
fn scrub_env(env: &mut HashMap<String, String>) {
    env.retain(|k, _| renderer_env_kept(k));
}

// ── Project config a CLI would load from the folder ─────────────────────────

/// Files of a project folder that a local-model CLI loads and that can point it at
/// another provider, relative to a folder on the way from the tab's cwd up to its
/// root (the CLIs search upward). Hidden in a verified tab's fence by
/// [`project_config_masks`]. Per CLI (`docs/context/local_models_only.md`):
/// OpenCode `opencode.json[c]` (checked), Claude Code `.claude/settings[.local].json`
/// whose `env` block beats the process environment (checked), Codex
/// `.codex/config.toml` (checked: it ignores provider keys there, masked anyway).
pub const PROJECT_CONFIG_FILES: &[&str] =
    &["opencode.json", "opencode.jsonc", ".claude/settings.json", ".claude/settings.local.json", ".codex/config.toml", "openclaw.json"];

/// Project folders the CLIs read config, plugins or provider definitions from: OpenCode's
/// `.opencode` (checked; its plugins are code), Pi's `.pi`, Droid's `.factory`,
/// Mistral Vibe's `.vibe`, Cline's `.cline` and OpenClaw's `.openclaw` (named from the
/// CLIs' documentation; those binaries were not installed to check).
pub const PROJECT_CONFIG_DIRS: &[&str] = &[".opencode", ".pi", ".factory", ".vibe", ".cline", ".openclaw"];

/// One path the fence covers: a file is bound over with `/dev/null` (empty, which
/// every CLI above reads as no config), a folder with an empty tmpfs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigMask {
    pub path: PathBuf,
    pub dir: bool,
}

/// The [`PROJECT_CONFIG_FILES`] and [`PROJECT_CONFIG_DIRS`] that exist, in `cwd`
/// and every folder above it up to the root of `roots` that holds it (and in each
/// root). Only what exists: a mount over nothing would create a placeholder in the
/// project. A file the agent creates later is covered at the next spawn, which
/// looks again. A name that is a link leading nowhere is an error — the fence
/// cannot cover what it cannot resolve — and so is a name the folder cannot be
/// asked about.
pub fn project_config_masks(roots: &[PathBuf], cwd: &Path) -> Result<Vec<ConfigMask>, String> {
    let mut bases: Vec<PathBuf> = roots.to_vec();
    let real_cwd = cwd.canonicalize().ok();
    for root in roots.iter().filter(|r| path_inside(cwd, r)) {
        // The CLIs walk up from the folder the process is in, which is the real
        // path of a cwd given through a link or a `..` (`getcwd`): a link inside
        // the folder, made by whoever wrote it, would otherwise hide the folders
        // it skips. Both are walked: the spelling given with its `..` folded, and the
        // real one below the root, spelled as the root is.
        let below_root = real_cwd.as_deref().zip(root.canonicalize().ok()).and_then(|(real, real_root)| {
            real.strip_prefix(&real_root).ok().map(|rel| root.join(rel))
        });
        for start in [Some(lexical(cwd)), below_root].into_iter().flatten() {
            let mut dir = Some(start.as_path());
            while let Some(d) = dir.filter(|d| d.starts_with(root) && *d != root.as_path()) {
                bases.push(d.to_path_buf());
                dir = d.parent();
            }
        }
    }
    bases.sort();
    bases.dedup();
    let mut out = Vec::new();
    for base in &bases {
        for names in [PROJECT_CONFIG_FILES, PROJECT_CONFIG_DIRS] {
            for name in names {
                let path = base.join(name);
                match std::fs::symlink_metadata(&path) {
                    Ok(_) => match std::fs::metadata(&path) {
                        Ok(meta) => out.push(ConfigMask { dir: meta.is_dir(), path }),
                        Err(e) => {
                            return Err(format!(
                                "{REFUSAL}: `{}` leads nowhere ({e}), so the sandbox cannot hide it from the agent. Remove it, or switch Local models only off.",
                                path.display()
                            ))
                        }
                    },
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    // A parent that is a file or cannot be searched: nothing is there to load.
                    Err(e) if matches!(e.kind(), std::io::ErrorKind::NotADirectory | std::io::ErrorKind::PermissionDenied) => {}
                    Err(e) => return Err(format!("{REFUSAL}: `{}` could not be looked at ({e}), so the sandbox was not built.", path.display())),
                }
            }
        }
    }
    Ok(out)
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

/// Whether the record marks the project remote or VM. A `null` value is absent,
/// as `services::remote::remote_target_for` and the root MCP read it; the setting
/// ([`check_enable`]) and the gate share this one reading, so a project that may
/// be locked is a project that may start an agent.
fn remote_or_vm(entry: &ProjectEntry) -> bool {
    ["remote", "vm"].iter().any(|k| entry.extra.get(*k).is_some_and(|v| !v.is_null()))
}

// ── What the backend can vouch for about a local `vibe` ─────────────────────

/// A local `vibe` launch the backend checked against the files it runs from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VibeLaunch {
    /// The Ollama model the home's config runs.
    pub model: String,
    /// The loopback `host:port` that config sends it to.
    pub endpoint: String,
}

/// The only `VIBE_*` variables a verified local `vibe` may carry: every other one
/// is a config field of its own (`VIBE_PROVIDERS`, `VIBE_MODELS`, …) and can
/// re-aim the model the home names.
const VIBE_ENV_KEPT: &[&str] = &["VIBE_HOME", "VIBE_ACTIVE_MODEL", "VIBE_MCP_SERVERS", "VIBE_ENABLED_TOOLS"];

/// Whether `opts` is a local `vibe` the backend can stand behind, and what it
/// runs, read from the **files** and not from the renderer's label
/// (`<APP>_LOCAL_MODEL`, which anything can set): a plain `vibe` argv, no
/// `VIBE_*` override but the two the frontend sets, a `VIBE_HOME` that is one of
/// Tabtivity's `vibe_local/<alias>[.<key>]` homes, and a `config.toml` there that
/// is exactly what `local_drivers::vibe_local_config` writes for one model on a
/// loopback Ollama. A bare `vibe` (Mistral's cloud CLI), a home of the user's, a
/// hand-edited config or a label with none of it is not local. The label, when
/// present, must name the same model. `share_dir` is `storage::home_share_dir()`.
pub fn local_vibe_launch(opts: &PtyOptions, share_dir: &Path) -> Option<VibeLaunch> {
    if program(&opts.cmd) != "vibe" || !vibe_args_ok(&opts.args) {
        return None;
    }
    let up = |k: &str| k.to_ascii_uppercase();
    if opts.env.keys().any(|k| up(k).starts_with("VIBE_") && !VIBE_ENV_KEPT.contains(&up(k).as_str())) {
        return None;
    }
    let home = PathBuf::from(opts.env.get("VIBE_HOME")?);
    let leaf = home.strip_prefix(share_dir.join("vibe_local")).ok()?;
    let mut parts = leaf.components();
    let (Some(Component::Normal(leaf)), None) = (parts.next(), parts.next()) else { return None };
    let leaf = leaf.to_str()?;
    // A real folder and a real file: a link planted in the shared store leads elsewhere.
    if !std::fs::symlink_metadata(&home).ok()?.is_dir() {
        return None;
    }
    let config_path = home.join("config.toml");
    if !std::fs::symlink_metadata(&config_path).ok()?.is_file() {
        return None;
    }
    let text = std::fs::read_to_string(&config_path).ok()?;
    let quoted = |line: &str, key: &str| -> Option<String> {
        let rest = line.strip_prefix(key)?.trim_start().strip_prefix('=')?.trim();
        Some(rest.strip_prefix('"')?.strip_suffix('"')?.to_string())
    };
    let alias = text.lines().find_map(|l| quoted(l, "active_model"))?;
    let endpoint = text.lines().find_map(|l| quoted(l, "api_base"))?.strip_prefix("http://")?.strip_suffix("/v1")?.to_string();
    let model = text.lines().skip_while(|l| l.trim() != "[[models]]").find_map(|l| quoted(l, "name"))?;
    let (host, _) = crate::services::ollama_client::split_host_port(&endpoint)?;
    let consistent = crate::services::local_drivers::model_name_ok(&model)
        && crate::services::ollama_client::host_is_loopback(host)
        && crate::services::ollama_client::sanitize_alias(&model) == alias
        && (leaf == alias || leaf.strip_prefix(alias.as_str()).is_some_and(|rest| rest.starts_with('.')))
        && opts.env.get("VIBE_ACTIVE_MODEL").is_none_or(|a| a.trim() == alias)
        && opts.env.get(crate::app_env!("LOCAL_MODEL")).is_none_or(|l| l.trim() == model);
    // The whole file, not a few lines of it: a second provider, a tool list or an
    // `api_base` further down would all pass a line scan.
    (consistent && text == crate::services::local_drivers::vibe_local_config(&model, &alias, &endpoint)).then_some(VibeLaunch { model, endpoint })
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
    let remote = projects.iter().find(|p| p.id == subject.id).is_some_and(remote_or_vm);
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

/// Whether content read from `file` must not go to the agent tabs of the
/// project whose folder is `root` (a markup Submit's prompt, the marked copy and
/// the layers it writes into `root`'s inbox, all delivered to a tab of that
/// project): `file` lies in a locked project's folder that is not `root` itself.
/// A locked project's own tabs are the gate's verified local ones, so a source
/// inside its own folder may go to them; the same file reached through a parent
/// project (or any other root) may not, since that project's tabs are not.
pub fn foreign_source_in(locked: &[Locked], root: &Path, file: &Path) -> bool {
    locked.iter().any(|l| {
        l.dir.as_deref().is_some_and(|dir| path_inside(file, dir) && !(path_inside(root, dir) && path_inside(dir, root)))
    })
}

/// [`foreign_source_in`] against the live registry; an unreadable one refuses.
pub fn foreign_source(root: &Path, file: &Path) -> bool {
    locked_now().map_or(true, |locked| foreign_source_in(&locked, root, file))
}

/// [`foreign_source`] against the registry file in `state_dir` (the phone's host
/// carries its own state dir): a missing file lists no project, an unreadable or
/// unparsable one refuses.
pub fn foreign_source_at(state_dir: &Path, root: &Path, file: &Path) -> bool {
    let path = state_dir.join("projects.json");
    if !path.exists() {
        return false;
    }
    crate::storage::read_json::<ProjectsList>(&path).map_or(true, |projects| foreign_source_in(&locked_projects(&projects), root, file))
}

/// Whether `path` lies in some locked project's folder (`locked`): a file of one
/// opened through another project that contains it, whose editor may send its
/// text to a cloud service.
pub fn inside_locked_in(locked: &[Locked], path: &Path) -> bool {
    locked.iter().any(|l| l.dir.as_deref().is_some_and(|dir| path_inside(path, dir)))
}

/// [`inside_locked_in`] against the live registry; an unreadable one says yes.
pub fn inside_locked(path: &Path) -> bool {
    locked_now().map_or(true, |locked| inside_locked_in(&locked, path))
}

/// Whether a text completion for project `project_id` is subject to the mode:
/// the project is local-models-only. An unreadable registry says yes (fail
/// closed); no project says no.
pub fn completion_locked(project_id: Option<&str>) -> bool {
    let Some(id) = project_id else { return false };
    locked_now().map_or(true, |locked| locked.iter().any(|l| l.id == id))
}

/// Why the editor's Ollama completion (`complete_text`) of a locked project may
/// not use `model`, or `None`: the prefix, suffix and attached files go to
/// whatever answers on the endpoint, and an Ollama cloud model is answered on
/// ollama.com. The model must be one `local` confirms ([`Probe::local`]'s rule).
pub fn completion_refusal_in(
    project_locked: bool,
    addr: &str,
    model: &str,
    local: &dyn Fn(&str, &str) -> Result<(), &'static str>,
) -> Option<String> {
    if !project_locked {
        return None;
    }
    local(addr, model).err().map(|verdict| {
        format!(
            "{REFUSAL}: this project is set to Local models only, so its text is completed only by a model that runs on this machine, and `{model}` is not confirmed to ({verdict}). Pick an installed local model."
        )
    })
}

/// [`completion_refusal_in`] against the live Ollama. Blocking: it asks `addr`.
pub fn completion_refusal(project_locked: bool, addr: &str, model: &str) -> Option<String> {
    completion_refusal_in(project_locked, addr, model, &|addr, model| crate::services::ollama_client::model_is_local_at(addr, model))
}

// ── Which live tabs can see a folder ────────────────────────────────────────

/// What one live agent's fence bound at its spawn, recorded by the wrappers
/// (`agent_fence::note_fence_view`): the paths it can read, and the locked
/// folders it hid then. A tab that started before a project was locked still
/// has the folder in `visible` and none in `masked`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FenceView {
    /// Project and box roots, the read-only allowlist and the root console's
    /// read-only project view.
    pub visible: Vec<PathBuf>,
    /// The locked folders ([`mask_dirs`]) the fence covered with an empty mount.
    pub masked: Vec<PathBuf>,
}

/// Whether a fence with `view` shows `dir`: some visible path is `dir`, holds it
/// or lies inside it (an allowlisted file below a project), and no mask covers
/// it. Any doubt about a path counts as seeing ([`path_inside`]).
pub fn sees(view: &FenceView, dir: &Path) -> bool {
    view.visible.iter().any(|v| path_inside(dir, v) || path_inside(v, dir)) && !view.masked.iter().any(|m| path_inside(dir, m))
}

/// The live PTYs turning Local models only on for `project` (folder `dir`) must
/// end: every AI PTY (`ais`: `(pty id, the tab it shows)`) that the gate did not
/// verify for the project and that either belongs to the project's own scope
/// (whatever its fence) or whose fence shows the folder (`views`: a parent
/// project's tab, a box tab, a root-console agent with the read-only project
/// view, any allowlist that covers it). The verified local tabs stay.
pub fn ptys_to_end(
    project: &str,
    dir: Option<&Path>,
    ais: &[(String, String)],
    views: &[(String, FenceView)],
    verified: &dyn Fn(&str) -> bool,
) -> Vec<String> {
    let own = format!("{project}:");
    ais.iter()
        .filter(|(_, tab)| !verified(tab))
        .filter(|(_, tab)| {
            tab.starts_with(&own)
                || dir.is_some_and(|dir| views.iter().any(|(id, view)| id == tab && sees(view, dir)))
        })
        .map(|(id, _)| id.clone())
        .collect()
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
    if remote_or_vm(entry) {
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

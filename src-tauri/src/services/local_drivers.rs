//! The local-model coding agents (`LOCAL_DRIVERS`: `ollama launch` and the
//! direct fallbacks), the launch lines a local-model tab may run or restore,
//! the inline OpenCode provider config and Codex's model catalog. Moved down
//! from `commands::ollama` (S5), which keeps the Tauri commands and
//! re-exports these names.

use crate::services::ollama_client::{
    model_context_length, model_has_capability, ollama_addr, ollama_status_read, sanitize_alias,
    validate_model_name, DEFAULT_OLLAMA_ADDR,
};

// ── Local-model coding agents (ollama launch + fallbacks) ─────────────────────
//
// Beyond Mistral's `vibe` (see `prepare_local_agent`), the single active local
// Ollama model can drive other coding agents. The preferred path is Ollama's own
// `ollama launch <agent> --model <model>` (shipped v0.15): it wires Claude Code,
// Codex, Droid, OpenClaw, Pi and Cline to the local server — including Claude Code's
// Anthropic-compatible endpoint, which we can't hand-roll the way vibe gets an
// OpenAI one. When `ollama launch` is unavailable we fall back to a direct
// invocation for the agents that natively accept a local Ollama endpoint.

/// A coding agent that can drive the local Ollama model.
#[derive(Clone, Copy)]
pub(crate) struct LocalDriver {
    /// Stable id used by the frontend picker and `prepare_local_launch`.
    pub(crate) id: &'static str,
    /// Human-readable label.
    pub(crate) label: &'static str,
    /// The agent's own binary name. The driver is only offered when this is
    /// actually installed — `ollama launch <sub>` still drives the agent's CLI,
    /// so a missing binary means the tab can't run regardless of `launch`.
    pub(crate) bin: &'static str,
    /// `ollama launch <sub> --model <model>` subcommand, when supported.
    pub(crate) launch_sub: Option<&'static str>,
    /// Direct fallback when `ollama launch` is unavailable: the binary to spawn
    /// and its args (with the `{model}` placeholder substituted). `None` means
    /// the agent can only be wired up by `ollama launch` itself.
    pub(crate) fallback: Option<(&'static str, &'static [&'static str])>,
    /// True when the agent drives the model through **tool/function calls**, so
    /// a model with no `tools` capability cannot run it at all — Ollama refuses
    /// the very first request with `does not support tools` and the tab is dead
    /// on arrival. Every entry below is `true`, because every entry is a coding
    /// agent; the flag is explicit rather than assumed because `vibe` — which is
    /// deliberately *not* in this list — takes the opposite route and turns
    /// tools off (`enabled_tools = ["__no_tools__"]` in `prepare_local_agent`),
    /// which is exactly why it still works on a completion-only model.
    pub(crate) needs_tools: bool,
    /// Extra **fallback** args that switch the agent's reasoning off, for the
    /// agents that send a reasoning effort whether or not the model can take
    /// one. `Some` carries a second meaning that matters more than the args:
    /// this driver must **bypass `ollama launch`** on a model with no
    /// `thinking` capability. An older `ollama launch <agent>` forwarded
    /// nothing — it rejected any extra flag with `unknown shorthand flag` (0.34
    /// passes args after `--`, which nothing here relies on yet) — so the
    /// override rides only the direct invocation, and `launch`'s own wiring (a
    /// generated `~/.codex/model.json` + profile) does not turn reasoning off
    /// on the user's behalf. `None` means the agent sends no reasoning field
    /// and runs on a non-thinking model unchanged.
    pub(crate) non_thinking_args: Option<&'static [&'static str]>,
    /// True when the agent needs a **model-metadata catalog** written for it on
    /// the direct-invocation path — the other thing `ollama launch` was doing
    /// (it generates `~/.codex/model.json` and points Codex at it). Without one
    /// Codex falls back to built-in metadata and reasons about the context
    /// window from a guess. See [`write_local_catalog`].
    pub(crate) wants_local_catalog: bool,
    /// True when the agent wraps every turn in a **large system prompt built for
    /// a frontier model** — tool schemas, sandbox and patch policy, the user's
    /// own `~/.codex` / `~/.claude` configuration and any MCP servers declared
    /// there. It is not a capability the model reports and there is no probe for
    /// it; it is a property of the *agent*, which is why it lives in this
    /// registry beside the launch wiring rather than being derived.
    ///
    /// It exists because the `tools` gate above is a gate against a tab that
    /// **cannot start**, and this is the other failure — a tab that starts and
    /// then answers badly. Measured on `qwen3-coder:latest`, which reports
    /// `tools` and passes every other check here: the plain Ollama chat endpoint
    /// answers `"test"` sensibly in 27 tokens, while Codex's harness put 5128
    /// tokens in front of the same model and it ran away past 4100 tokens
    /// without stopping. Nothing about the model's advertised capabilities
    /// predicts that.
    ///
    /// It is deliberately **not** a reason to withhold the driver. Which local
    /// models cope is a fact about the model, the machine and the task, and the
    /// only honest thing to do with an unprobeable risk is to say so and let the
    /// user try it — the alternative, hiding the agent, is what the `thinking`
    /// capability was considered for and rejected: no model on the reporting
    /// machine carried both `tools` and `thinking`, so gating on it would have
    /// emptied the group entirely rather than steered anyone to a better model.
    ///
    /// Most entries are `true`: general-purpose coding-agent CLIs written
    /// against hosted frontier models. OpenCode is `false` — it is
    /// provider-agnostic and drives local models well, which is also why it
    /// heads the picker, ahead of Mistral's `vibe` (built for local models, and
    /// *not* in this list because it keeps its own launch path).
    pub(crate) heavy_harness: bool,
}

/// Registry of local-model coding agents, in picker order (the light-harness
/// ones are offered ahead of Mistral, the rest after it). `vibe` is intentionally
/// absent — it keeps its bespoke per-model VIBE_HOME path in `prepare_local_agent`.
pub(crate) const LOCAL_DRIVERS: &[LocalDriver] = &[
    LocalDriver {
        id: "opencode",
        label: "OpenCode",
        bin: "opencode",
        // Never `ollama launch`: it sets its own `OPENCODE_CONFIG_CONTENT`
        // (clobbering the loaded-models list `pty_spawn` hands every OpenCode —
        // see `opencode_loaded_models_config`) and appends each launched model
        // to the user's opencode.jsonc for good.
        launch_sub: None,
        // The `ollama` provider — named by the user's config or by the inline
        // one `pty_spawn` injects; `--model ollama/<model>` selects it.
        fallback: Some(("opencode", &["--model", "ollama/{model}"])),
        needs_tools: true,
        non_thinking_args: None,
        wants_local_catalog: false,
        heavy_harness: false,
    },
    LocalDriver {
        id: "pi",
        label: "Pi",
        bin: "pi",
        // `ollama launch pi` writes Pi's `models.json` provider (with
        // `reasoning` only for a thinking model) into the tab's local-model
        // home; no hand-rolled fallback, since none could be verified.
        launch_sub: Some("pi"),
        fallback: None,
        needs_tools: true,
        non_thinking_args: None,
        wants_local_catalog: false,
        // A short system prompt and four tools: built to cope with small models.
        heavy_harness: false,
    },
    LocalDriver {
        id: "claude",
        label: "Claude Code",
        bin: "claude",
        launch_sub: Some("claude"),
        // Claude Code needs an Anthropic-compatible endpoint, which only
        // `ollama launch` stands up — no reliable hand-rolled fallback.
        fallback: None,
        needs_tools: true,
        non_thinking_args: None,
        wants_local_catalog: false,
        heavy_harness: true,
    },
    LocalDriver {
        id: "codex",
        label: "Codex",
        bin: "codex",
        launch_sub: Some("codex"),
        // `codex --oss -m <model>` talks to the local Ollama server directly.
        // `oss_provider` is named because Codex ≥0.146 refuses `--oss` with
        // "No default OSS provider configured" unless one is set; it goes
        // through `-c` rather than the `--local-provider` flag that error
        // suggests, because an unknown *config key* is ignored by an older
        // Codex while an unknown *flag* is a hard argv error.
        fallback: Some((
            "codex",
            &["--oss", "-c", "oss_provider=\"ollama\"", "-m", "{model}"],
        )),
        needs_tools: true,
        non_thinking_args: Some(&["-c", "model_reasoning_effort=\"none\""]),
        wants_local_catalog: true,
        heavy_harness: true,
    },
    LocalDriver {
        id: "droid",
        label: "Droid",
        bin: "droid",
        launch_sub: Some("droid"),
        // Droid is configured via ~/.factory/config.json; only `ollama launch`
        // writes that wiring for us.
        fallback: None,
        needs_tools: true,
        non_thinking_args: None,
        wants_local_catalog: false,
        heavy_harness: true,
    },
    LocalDriver {
        id: "openclaw",
        label: "OpenClaw",
        bin: "openclaw",
        launch_sub: Some("openclaw"),
        // Launch-only: `ollama launch openclaw` installs OpenClaw if missing and
        // stands up its gateway against the local Ollama endpoint. There's no
        // documented standalone flag to point `openclaw` at a local server, so
        // no hand-rolled fallback.
        fallback: None,
        needs_tools: true,
        non_thinking_args: None,
        wants_local_catalog: false,
        heavy_harness: true,
    },
    LocalDriver {
        id: "cline",
        label: "Cline",
        bin: "cline",
        // `ollama launch cline` merges an `ollama` provider into Cline's
        // `providers.json` — its login file, per scope since 2026-10-08; a
        // local-model home still never feeds the login store
        // (`agent_auth::reconcile_file`).
        launch_sub: Some("cline"),
        fallback: None,
        needs_tools: true,
        non_thinking_args: None,
        wants_local_catalog: false,
        heavy_harness: true,
    },
];

/// True when the installed Ollama exposes the `launch` subcommand (v0.15+).
/// Cheap probe: `ollama launch --help` exits 0 only when the subcommand exists.
pub(crate) fn ollama_has_launch() -> bool {
    crate::paths::command_no_window("ollama")
        .args(["launch", "--help"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Build the fallback launch spec for a driver, substituting `{model}` and
/// appending `extra` (the reasoning-off override, when one is needed). Pure +
/// tested; `prepare_local_launch` uses it when `ollama launch` is missing — or
/// when `extra` is non-empty, since `launch` cannot carry it.
pub(crate) fn fallback_spec(driver: &LocalDriver, model: &str, extra: &[&str]) -> Option<LocalLaunchSpec> {
    driver.fallback.map(|(bin, args)| LocalLaunchSpec {
        cmd: bin.to_string(),
        args: args
            .iter()
            .chain(extra.iter())
            .map(|a| a.replace("{model}", model))
            .collect(),
    })
}

/// Whether `cmd args` is a launch line [`prepare_local_launch`] can have
/// produced for `driver` and `model` — the check a persisted local-model tab
/// (`localLaunch` in `terminals.json`) passes before a restore may run it again
/// (`services::terminal_service`), and before the phone may attach to it
/// (`services::mobile_control::discovery`).
///
/// It enumerates the forms instead of re-resolving: `ollama launch`, the direct
/// fallback with or without the reasoning-off override, and Codex's catalog
/// pair after either. So it probes nothing, and a line written while
/// `ollama launch` existed stays valid after a downgrade — it then fails at
/// spawn, exactly as a fresh launch would. A model that could read as a flag
/// is refused although `validate_model_name` lets a leading `-` through.
pub(crate) fn local_launch_line_ok(driver: &str, model: &str, cmd: &str, args: &[String]) -> bool {
    let Some(driver) = LOCAL_DRIVERS.iter().find(|d| d.id == driver) else {
        return false;
    };
    if validate_model_name(model).is_err() || model != model.trim() || model.starts_with('-') {
        return false;
    }
    if let Some(sub) = driver.launch_sub {
        if cmd == "ollama" && args == ["launch", sub, "--model", model] {
            return true;
        }
        // No `--` tail is accepted here, whatever the scope: the chat
        // assistant's pinned tail (`services::assistant::claude_local_tail_ok`)
        // is built and checked by the assistant's own launch path, against the
        // lane that spawn was granted. A persisted `localLaunch` of a project
        // tab must match the plain line exactly.
    }
    let catalog = driver
        .wants_local_catalog
        .then(|| catalog_arg_pair(&local_catalog_path(model)));
    [&[][..], driver.non_thinking_args.unwrap_or(&[])]
        .iter()
        .filter_map(|extra| fallback_spec(driver, model, extra))
        .any(|spec| {
            spec.cmd == cmd
                && (args == spec.args
                    || catalog.as_ref().is_some_and(|pair| {
                        args.len() == spec.args.len() + pair.len()
                            && args[..spec.args.len()] == spec.args[..]
                            && args[spec.args.len()..] == pair[..]
                    }))
        })
}

/// The CLI a local driver runs (`claude` for `"claude"`), for naming the agent
/// of a persisted local-model tab whose own `cmd` may be `ollama`.
pub(crate) fn local_driver_bin(driver: &str) -> Option<&'static str> {
    LOCAL_DRIVERS.iter().find(|d| d.id == driver).map(|d| d.bin)
}

/// The launch line of local `driver` for `model` as [`prepare_local_launch`]
/// builds it, without its probes (installed `ollama launch`, the model's tool
/// and thinking capabilities): `ollama launch <sub> --model <m>` for a driver
/// that has one, else the direct fallback with no reasoning override. `None`
/// for an unknown driver, one with neither form, or a model
/// [`local_launch_line_ok`] would refuse. The chat assistant builds its line
/// from this instead of copying the driver table (`services::assistant`).
pub(crate) fn pinned_local_line(driver: &str, model: &str) -> Option<LocalLaunchSpec> {
    let driver = LOCAL_DRIVERS.iter().find(|d| d.id == driver)?;
    if !model_name_ok(model) {
        return None;
    }
    if let Some(sub) = driver.launch_sub {
        return Some(LocalLaunchSpec {
            cmd: "ollama".to_string(),
            args: ["launch", sub, "--model", model].map(str::to_string).to_vec(),
        });
    }
    fallback_spec(driver, model, &[])
}

/// Whether `model` is a name Tabtivity passes to an agent CLI as a discrete
/// argument: [`validate_model_name`]'s character set, no surrounding space
/// and no leading `-` (which a CLI would read as a flag).
pub(crate) fn model_name_ok(model: &str) -> bool {
    validate_model_name(model).is_ok() && model == model.trim() && !model.starts_with('-')
}

/// The extra args this driver needs for `model`, and whether they force the
/// direct invocation. Pure so the rule is testable without an Ollama:
/// `thinking` is the already-narrowed [`model_supports_thinking`] answer, so
/// "could not tell" arrives as `None` and changes nothing — an agent that
/// errors is recoverable, one silently stripped of reasoning is not.
pub(crate) fn non_thinking_override(driver: &LocalDriver, thinking: Option<bool>) -> &[&'static str] {
    match (driver.non_thinking_args, thinking) {
        (Some(args), Some(false)) => args,
        _ => &[],
    }
}

// ── OpenCode: the loaded Ollama models, handed over at launch ─────────────────
//
// OpenCode's `ollama` provider lists whatever models its config names — a list
// that goes stale the moment another model is loaded (`ollama launch opencode`
// appends to it and never prunes). Tabtivity never edits OpenCode's config, so an
// OpenCode spawn gets `OPENCODE_CONFIG_CONTENT` instead: an inline config
// OpenCode deep-merges over the user's own, naming the models resident in
// Ollama right now and whitelisting only those.

/// The model an OpenCode spawn asks for, or `None` when `cmd`/`args` do not
/// start OpenCode at all. The inner `Option` is the requested **Ollama** model
/// — `opencode --model ollama/<m>` (the direct fallback) or `ollama launch
/// opencode --model <m>` — which is whitelisted even when not loaded yet, since
/// Ollama loads it on the first request and hiding it would kill the tab.
pub(crate) fn opencode_spawn_model(cmd: &str, args: &[String]) -> Option<Option<String>> {
    let bin = std::path::Path::new(cmd)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(cmd);
    let via_launch = match bin {
        "opencode" => false,
        "ollama" if args.first().map(String::as_str) == Some("launch")
            && args.get(1).map(String::as_str) == Some("opencode") =>
        {
            true
        }
        _ => return None,
    };
    let model = args.iter().enumerate().find_map(|(i, a)| {
        a.strip_prefix("--model=")
            .map(str::to_string)
            .or_else(|| (a == "--model" || a == "-m").then(|| args.get(i + 1).cloned()).flatten())
    });
    Some(model.and_then(|m| {
        if via_launch {
            Some(m)
        } else {
            m.strip_prefix("ollama/").map(str::to_string)
        }
    }))
}

/// Model names from an `/api/ps` body, or `None` when the body is not one.
pub(crate) fn loaded_model_names(ps_body: &str) -> Option<Vec<String>> {
    let v = serde_json::from_str::<serde_json::Value>(ps_body).ok()?;
    Some(
        v["models"]
            .as_array()?
            .iter()
            .filter_map(|m| m["name"].as_str().or_else(|| m["model"].as_str()))
            .map(str::to_string)
            .collect(),
    )
}

/// The inline OpenCode config: the `ollama` provider pointed at `addr`, carrying
/// `loaded` (plus `requested`) as its models and whitelisting exactly those, so
/// models the user's config names but Ollama has not loaded drop out of the
/// picker. An empty list is kept deliberately: nothing loaded means no Ollama
/// models to offer. Pure + tested.
pub(crate) fn opencode_ollama_config(addr: &str, loaded: &[String], requested: Option<&str>) -> String {
    let mut names: Vec<&str> = loaded.iter().map(String::as_str).collect();
    if let Some(r) = requested.filter(|r| !r.is_empty() && !names.contains(r)) {
        names.push(r);
    }
    let models: serde_json::Map<String, serde_json::Value> = names
        .iter()
        .map(|n| (n.to_string(), serde_json::json!({ "name": n })))
        .collect();
    serde_json::json!({
        "provider": {
            "ollama": {
                "npm": "@ai-sdk/openai-compatible",
                "name": "Ollama (local)",
                "options": { "baseURL": format!("http://{addr}/v1") },
                "models": models,
                "whitelist": names,
            }
        }
    })
    .to_string()
}

/// `OPENCODE_CONFIG_CONTENT` for an OpenCode spawn asking for `requested`, or
/// `None` when Ollama cannot be asked — an unreachable server leaves the user's
/// own config alone rather than emptying its model list on a guess.
pub(crate) fn opencode_loaded_models_config(requested: Option<&str>) -> Option<String> {
    let loaded = loaded_model_names(&ollama_status_read("/api/ps").ok()?)?;
    let addr = ollama_addr().ok()?;
    Some(opencode_ollama_config(&addr, &loaded, requested))
}

/// The inline OpenCode config an assistant chat merges its own settings into:
/// [`opencode_loaded_models_config`], or — when Ollama cannot be asked — the
/// same `ollama` provider block with no loaded models and `requested` alone,
/// since the assistant home holds no config of the user's to fall back on.
pub(crate) fn opencode_assistant_provider(requested: &str) -> String {
    opencode_loaded_models_config(Some(requested)).unwrap_or_else(|| {
        let addr = ollama_addr().unwrap_or_else(|_| DEFAULT_OLLAMA_ADDR.to_string());
        opencode_ollama_config(&addr, &[], Some(requested))
    })
}

/// The command + args to spawn for a local-model agent tab.
#[derive(serde::Serialize)]
pub struct LocalLaunchSpec {
    pub cmd: String,
    pub args: Vec<String>,
}

/// The catalog `-c` args for a direct Codex launch, or nothing if we couldn't
/// write one. See [`write_local_catalog`].
pub(crate) fn local_catalog_args(model: &str, thinking: Option<bool>) -> Vec<String> {
    match write_local_catalog(model, thinking) {
        Ok(path) => catalog_arg_pair(&path),
        Err(_) => Vec::new(),
    }
}

/// `-c model_catalog_json=<toml string>` for `path`. A JSON string literal is
/// a valid TOML basic string, and serde does the escaping — the path is
/// Tabtivity's own but it descends from `$HOME`, which we do not get to assume is
/// free of quotes or backslashes.
pub(crate) fn catalog_arg_pair(path: &std::path::Path) -> Vec<String> {
    vec![
        "-c".to_string(),
        format!(
            "model_catalog_json={}",
            serde_json::Value::from(path.to_string_lossy().as_ref())
        ),
    ]
}

/// Where [`write_local_catalog`] keeps `model`'s catalog.
pub(crate) fn local_catalog_path(model: &str) -> std::path::PathBuf {
    crate::storage::home_share_dir()
        .join("codex_local")
        .join(sanitize_alias(model))
        .join("model.json")
}

/// Write the model-metadata catalog Codex asks for, into **Tabtivity's own** state
/// dir — never `~/.codex`, which is another application's to manage.
///
/// Without it Codex prints `Model metadata for '<model>' not found. Defaulting
/// to fallback metadata` and then reasons about the context window from a
/// built-in guess: it does not know that `qwen3-coder` holds 262 144 tokens, so
/// it compacts against the wrong number — either throwing away context that
/// still fit, or overrunning the model's window and getting a truncation Ollama
/// never reports back as one. `ollama launch` generates exactly this file
/// (`~/.codex/model.json`); the direct invocation that a non-thinking model
/// forces us onto is what left the agent without it.
///
/// The field set is Ollama's own for that generated file — the shape its
/// authors established Codex accepts — with the two model-dependent facts read
/// off `/api/show` rather than assumed: the context window, and whether any
/// reasoning level may be offered at all.
pub(crate) fn write_local_catalog(model: &str, thinking: Option<bool>) -> Result<std::path::PathBuf, String> {
    validate_model_name(model)?;
    let path = local_catalog_path(model);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("catalog dir: {e}"))?;
    }

    let body = local_catalog_json(
        model,
        thinking,
        model_context_length(model),
        model_has_capability(model, "vision") == Some(true),
    );
    std::fs::write(&path, body).map_err(|e| format!("catalog write: {e}"))?;
    Ok(path)
}

/// The catalog document itself — pure, so the shape Codex is handed is a unit
/// test rather than a thing only observable by launching an agent.
pub(crate) fn local_catalog_json(
    model: &str,
    thinking: Option<bool>,
    context_window: Option<u64>,
    vision: bool,
) -> String {
    // A model positively known to lack `thinking` gets an empty level list, so
    // Codex has the fact rather than only the `-c model_reasoning_effort` order
    // to obey. "Could not tell" leaves the standard levels, matching the rest
    // of the capability rules: absence of an answer never removes a capability.
    //
    // `description` is required (`ReasoningEffortPreset`): Codex reads the
    // catalog as part of its config, so a level without one makes it exit on
    // "missing field `description`" before the TUI opens.
    let levels: Vec<serde_json::Value> = if thinking == Some(false) {
        Vec::new()
    } else {
        [
            ("low", "Fast responses with lighter reasoning"),
            ("medium", "Balances speed and reasoning depth"),
            ("high", "Greater reasoning depth for complex problems"),
        ]
        .iter()
        .map(|(effort, description)| serde_json::json!({ "effort": effort, "description": description }))
        .collect()
    };
    let mut modalities = vec!["text"];
    if vision {
        modalities.push("image");
    }

    let mut entry = serde_json::json!({
        "slug": model,
        "display_name": model,
        "base_instructions": "",
        "default_verbosity": "low",
        "support_verbosity": true,
        "experimental_supported_tools": [],
        "input_modalities": modalities,
        "priority": 0,
        "shell_type": "default",
        "supported_in_api": true,
        "supported_reasoning_levels": levels,
        "supports_parallel_tool_calls": false,
        "supports_reasoning_summaries": false,
        "truncation_policy": { "mode": "bytes", "limit": 10000 },
        "visibility": "list",
    });
    // Omitted rather than guessed when Ollama won't say: a wrong context window
    // is worse than the fallback, because it is wrong with confidence.
    if let Some(ctx) = context_window {
        entry["context_window"] = serde_json::json!(ctx);
    }
    serde_json::json!({ "models": [entry] }).to_string()
}

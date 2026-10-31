//! User-selected startup defaults. Applied once, before any SSH/container/fence
//! wrapping, only to new sessions; explicit launch choices always win.
use crate::{schema::Settings, terminal::PtyOptions};

#[derive(serde::Serialize)]
pub struct Capabilities {
    pub model: bool,
    pub efforts: &'static [&'static str],
    pub effort_requires_model: bool,
}

// Native flags checked against installed --help (Claude, Codex, Antigravity,
// Copilot, Muse, OpenCode mini) and vendor CLI references, 2026-10-29.
// No guessed flags for CLIs without a verified startup setting.
fn model_flag(cmd: &str) -> Option<&'static str> {
    match cmd {
        "claude" | "codex" | "agy" | "gemini" | "kiro-cli" | "cline" | "aider" | "opencode"
        | "cursor-agent" | "copilot" | "droid" | "grok" | "qwen" | "auggie" | "kilo" | "cn"
        | "junie" | "codebuddy" | "pi" | "mini" | "kimi" | "qoder" | "muse" => Some("--model"),
        "sweagent" => Some("--agent.model.name"),
        _ => None,
    }
}

fn effort_flag(cmd: &str) -> Option<&'static str> {
    match cmd {
        "claude" | "agy" | "kiro-cli" | "grok" | "junie" => Some("--effort"),
        "copilot" | "droid" | "qoder" | "muse" | "aider" => Some("--reasoning-effort"),
        "cline" | "pi" | "auggie" => Some("--thinking"),
        _ => None,
    }
}

fn model_env(cmd: &str) -> Option<&'static str> {
    match cmd {
        "claude" => Some("ANTHROPIC_MODEL"),
        "gemini" => Some("GEMINI_MODEL"),
        "copilot" => Some("COPILOT_MODEL"),
        "aider" => Some("AIDER_MODEL"),
        "junie" => Some("JUNIE_MODEL"),
        "mini" => Some("MSWEA_MODEL_NAME"),
        "goose" => Some("GOOSE_MODEL"),
        "vibe" => Some("VIBE_ACTIVE_MODEL"),
        _ => None,
    }
}

fn launch_model(cmd: &str, model: &str, effort: Option<&str>) -> String {
    if cmd == "opencode" {
        if let Some(effort) = effort {
            let model = model.split_once('#').map_or(model, |(model, _)| model);
            return format!("{model}#{effort}");
        }
    }
    model.into()
}

pub fn capabilities(cmd: &str) -> Capabilities {
    let opencode_v2 = cmd == "opencode"
        && crate::services::agent_versions::opencode_is_v2(
            crate::services::agent_versions::load().get("opencode"),
        );
    let efforts: &'static [&'static str] = match cmd {
        "opencode" if opencode_v2 => &["none", "minimal", "low", "medium", "high", "xhigh", "max"],
        "claude" | "agy" | "kiro-cli" | "grok" => &["low", "medium", "high", "xhigh", "max"],
        "codex" | "muse" => &[
            "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
        ],
        "copilot" | "aider" => &["none", "minimal", "low", "medium", "high", "xhigh", "max"],
        "kimi" => &["off", "on"],
        "droid" => &[
            "none", "dynamic", "off", "minimal", "low", "medium", "high", "xhigh", "max",
        ],
        "cline" => &["none", "low", "medium", "high", "xhigh"],
        "pi" => &["off", "minimal", "low", "medium", "high", "xhigh"],
        "auggie" | "junie" => &["minimal", "low", "medium", "high", "xhigh", "max"],
        "qoder" => &["low", "medium", "high", "xhigh", "max"],
        _ => &[],
    };
    Capabilities {
        model: model_flag(cmd).is_some() || matches!(cmd, "goose" | "vibe"),
        efforts,
        effort_requires_model: matches!(cmd, "opencode" | "junie"),
    }
}

fn has_flag(args: &[String], flags: &[&str]) -> bool {
    args.iter().any(|arg| {
        flags.iter().any(|flag| {
            arg == flag
                || arg.strip_prefix(flag).is_some_and(|tail| {
                    tail.starts_with('=') || (flag.len() == 2 && !tail.is_empty())
                })
        })
    })
}

fn config_key(args: &[String], key: &str) -> bool {
    args.iter().enumerate().any(|(i, arg)| {
        let value = if arg == "-c" || arg == "--config" {
            args.get(i + 1).map(String::as_str)
        } else {
            arg.strip_prefix("--config=")
                .or_else(|| arg.strip_prefix("-c"))
        };
        value.is_some_and(|value| value.split_once('=').is_some_and(|(k, _)| k.trim() == key))
    })
}

fn session_command(cmd: &str, args: &[String]) -> bool {
    if args
        .iter()
        .any(|arg| matches!(arg.as_str(), "--" | "--help" | "-h" | "--version" | "-V"))
    {
        return false;
    }
    let first = args.first().map(String::as_str);
    first.is_none_or(|arg| arg.starts_with('-'))
        || matches!(
            (cmd, first),
            ("opencode", Some("mini"))
                | ("kiro-cli", Some("chat"))
                | ("goose", Some("session"))
                | ("sweagent", Some("run"))
        )
}

pub fn resumed(cmd: &str, args: &[String]) -> bool {
    has_flag(
        args,
        &[
            "--resume",
            "--continue",
            "--conversation",
            "--connect",
            "--id",
            "--session",
        ],
    ) || matches!(args.first().map(String::as_str), Some("resume" | "fork"))
        || (matches!(
            cmd,
            "claude" | "agy" | "opencode" | "cursor-agent" | "copilot" | "grok" | "qwen" | "vibe"
        ) && has_flag(args, &["-r", "-c"]))
        || (cmd == "opencode" && has_flag(args, &["-s"]))
}

/// Reads trusted application settings, never a project's config. No writes.
pub fn apply(opts: &mut PtyOptions) {
    // Copilot's resolver uses --session-id for both new and resumed sessions.
    // A hook record distinguishes the latter even when the caller sent no
    // --continue (for example a reconnect to an already-owned tab).
    if opts.cmd == "copilot"
        && opts.env.get(crate::app_env!("TAB_UID")).is_some_and(|uid| {
            crate::services::copilot_session::live_id(opts.project_id.as_deref(), uid).is_some()
        })
    {
        return;
    }
    if let Ok(settings) = crate::storage::read_json::<Settings>(&crate::storage::settings_path()) {
        apply_in(opts, &settings);
    }
}

fn apply_in(opts: &mut PtyOptions, settings: &Settings) {
    if opts.assistant.is_some()
        || opts.login.is_some()
        || opts.tmux_attach.is_some()
        || opts.local_model
        || crate::services::agent_api_keys::is_local_model(opts)
    {
        return;
    }
    let cmd = stem(&opts.cmd);
    if !session_command(cmd, &opts.args) || resumed(cmd, &opts.args) {
        return;
    }
    let Some(defaults) = settings
        .extra
        .get("agent_launch_defaults")
        .and_then(|v| v.get(cmd))
    else {
        return;
    };
    let cap = capabilities(cmd);
    let model = defaults
        .get("model")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 256
                && !s.starts_with('-')
                && !s.chars().any(char::is_control)
        });
    // An explicit model also owns its effort: avoid pairing a tab's model
    // with an effort chosen for another model in settings.
    let explicit_model = has_flag(&opts.args, &["--model", "-m", "--agent.model.name"])
        || (cmd == "codex"
            && (config_key(&opts.args, "model")
                || has_flag(&opts.args, &["--profile", "-p", "--oss"])))
        || model_env(cmd).is_some_and(|key| opts.env.contains_key(key));
    if explicit_model {
        return;
    }
    let effort = defaults
        .get("effort")
        .and_then(|v| v.as_str())
        .filter(|e| cap.efforts.contains(e));
    if let Some(model) = model {
        if let Some(flag) = model_flag(cmd) {
            if cmd == "sweagent" && opts.args.first().is_none_or(|a| a != "run") {
                opts.args.insert(0, "run".into());
            }
            let model = launch_model(cmd, model, effort);
            opts.args.extend([flag.to_string(), model]);
        } else if cmd == "goose" {
            opts.env.insert("GOOSE_MODEL".into(), model.into());
        } else if cmd == "vibe" {
            opts.env.insert("VIBE_ACTIVE_MODEL".into(), model.into());
        }
    }
    if let Some(effort) = effort {
        // Junie requires an explicit model. OpenCode variants are part of the
        // model ID (provider/model#variant), not a root --effort flag.
        if cmd == "junie" && model.is_none() {
            return;
        }
        if cmd == "codex" {
            if !config_key(&opts.args, "model_reasoning_effort") {
                opts.args.extend([
                    "-c".into(),
                    format!("model_reasoning_effort={}", serde_json::json!(effort)),
                ]);
            }
        } else if cmd == "kimi" {
            if !has_flag(&opts.args, &["--thinking", "--no-thinking"]) {
                opts.args.push(
                    if effort == "on" {
                        "--thinking"
                    } else {
                        "--no-thinking"
                    }
                    .into(),
                );
            }
        } else if let Some(flag) = effort_flag(cmd) {
            if !has_flag(
                &opts.args,
                &[flag, "--effort", "--reasoning-effort", "--thinking"],
            ) {
                opts.args.extend([flag.to_string(), effort.to_string()]);
            }
        }
    }
}

/// The key a CLI's defaults are saved and applied under: its command's file
/// stem (`claude` for `/usr/bin/claude`, `claude.exe`).
pub fn stem(cmd: &str) -> &str {
    std::path::Path::new(cmd)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(cmd)
}

/// One CLI's saved startup choices, as the phone's model sheet reads and edits
/// them (`mobile_control` `launch-defaults`). Blank leaves it to the CLI.
#[derive(Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Saved {
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub effort: String,
}

pub fn saved_in(settings: &Settings, cmd: &str) -> Saved {
    let entry = settings
        .extra
        .get("agent_launch_defaults")
        .and_then(|v| v.get(cmd));
    let field = |key: &str| {
        entry
            .and_then(|v| v.get(key))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string()
    };
    Saved { model: field("model"), effort: field("effort") }
}

/// Why `saved` cannot be kept for `cmd` — what the desktop form refuses too.
pub fn check(cmd: &str, saved: &Saved) -> Result<(), &'static str> {
    let cap = capabilities(cmd);
    let model = saved.model.trim();
    if !model.is_empty()
        && (!cap.model
            || model.len() > 256
            || model.starts_with('-')
            || model.chars().any(char::is_control))
    {
        return Err("invalid_model");
    }
    if !saved.effort.is_empty() {
        if !cap.efforts.contains(&saved.effort.as_str()) {
            return Err("invalid_effort");
        }
        if cap.effort_requires_model && model.is_empty() {
            return Err("effort_needs_model");
        }
    }
    Ok(())
}

/// Keeps `saved` as `cmd`'s defaults (both blank removes them) under the
/// settings file's lock, leaving every other CLI's entry and setting as the
/// file has them.
pub fn save_in(path: &std::path::Path, cmd: &str, saved: &Saved) -> Result<(), String> {
    check(cmd, saved).map_err(str::to_string)?;
    let model = saved.model.trim();
    crate::storage::patch_json(path, Settings::default(), |settings| {
        let entry = settings
            .extra
            .entry("agent_launch_defaults".into())
            .or_insert_with(|| serde_json::json!({}));
        if !entry.is_object() {
            *entry = serde_json::json!({});
        }
        let Some(map) = entry.as_object_mut() else { unreachable!() };
        if model.is_empty() && saved.effort.is_empty() {
            map.remove(cmd);
        } else {
            map.insert(cmd.into(), serde_json::json!({ "model": model, "effort": saved.effort }));
        }
        settings.rev += 1;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn opencode_effort_selects_the_variant_and_blank_keeps_a_custom_variant() {
        assert_eq!(
            launch_model("opencode", "provider/model", Some("high")),
            "provider/model#high"
        );
        assert_eq!(
            launch_model("opencode", "provider/model#low", Some("high")),
            "provider/model#high"
        );
        assert_eq!(
            launch_model("opencode", "provider/model#custom", None),
            "provider/model#custom"
        );
    }

    fn opts(cmd: &str, args: &[&str]) -> PtyOptions {
        PtyOptions {
            id: "p:t".into(),
            cmd: cmd.into(),
            args: args.iter().map(|s| (*s).into()).collect(),
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
            env: Default::default(),
            cols: 80,
            rows: 24,
            local_only: false,
            sandbox: false,
            agent: true,
            project_id: None,
            remote_host_id: None,
            tmux_session: None,
            tmux_attach: None,
            host_bound_uid: None,
            local_model: false,
            schedule_target_id: None,
            host_session: false,
            api_key: None,
            login: None,
            assistant: None,
        }
    }

    fn settings(cmd: &str, model: &str, effort: &str) -> Settings {
        serde_json::from_value(
            json!({"agent_launch_defaults": {cmd: {"model":model, "effort":effort}}}),
        )
        .unwrap()
    }

    #[test]
    fn native_defaults_reach_new_sessions_only_and_preserve_other_settings() {
        for (cmd, flag) in [
            ("claude", "--effort"),
            ("agy", "--effort"),
            ("copilot", "--reasoning-effort"),
            ("muse", "--reasoning-effort"),
            ("cline", "--thinking"),
        ] {
            let settings = settings(cmd, "my-model", "high");
            let mut fresh = opts(cmd, &[]);
            apply_in(&mut fresh, &settings);
            assert_eq!(fresh.args, ["--model", "my-model", flag, "high"], "{cmd}");
            let mut resumed = opts(cmd, &["--resume", "saved"]);
            apply_in(&mut resumed, &settings);
            assert_eq!(resumed.args, ["--resume", "saved"]);
            let mut login = opts(cmd, &["login"]);
            apply_in(&mut login, &settings);
            assert_eq!(login.args, ["login"]);
        }
    }

    #[test]
    fn codex_toml_overrides_are_quoted_and_do_not_change_modes() {
        let mut fresh = opts("codex", &[]);
        apply_in(&mut fresh, &settings("codex", "custom-model", "ultra"));
        assert_eq!(
            fresh.args,
            [
                "--model",
                "custom-model",
                "-c",
                "model_reasoning_effort=\"ultra\""
            ]
        );
        for args in [
            vec!["-c", "model='explicit'"],
            vec!["--config=model='explicit'"],
            vec!["-mmine"],
            vec!["--model=explicit"],
            vec!["--profile", "work"],
            vec!["resume", "saved"],
        ] {
            let mut explicit = opts("codex", &args);
            apply_in(&mut explicit, &settings("codex", "default", "high"));
            assert_eq!(explicit.args, args, "{args:?}");
        }
    }

    #[test]
    fn an_explicit_effort_wins_but_can_use_the_default_model() {
        let mut explicit = opts("codex", &["-c", "model_reasoning_effort = 'low'"]);
        apply_in(&mut explicit, &settings("codex", "default", "high"));
        assert_eq!(
            explicit.args,
            ["-c", "model_reasoning_effort = 'low'", "--model", "default"]
        );
        let mut claude = opts("claude", &["--effort=low"]);
        apply_in(&mut claude, &settings("claude", "opus", "high"));
        assert_eq!(claude.args, ["--effort=low", "--model", "opus"]);
    }

    #[test]
    fn local_models_attached_tmux_and_subcommands_are_untouched() {
        let settings = settings("claude", "opus", "high");
        let mut local = opts("claude", &[]);
        local.local_model = true;
        let mut env_local = opts("claude", &[]);
        env_local
            .env
            .insert(crate::app_env!("LOCAL_MODEL").into(), "local".into());
        let mut attached = opts("claude", &[]);
        attached.tmux_attach = Some("existing".into());
        for mut tab in [local, env_local, attached] {
            apply_in(&mut tab, &settings);
            assert!(tab.args.is_empty());
        }
        let mut shell = opts("bash", &[]);
        apply_in(&mut shell, &settings);
        assert!(shell.args.is_empty());
    }

    #[test]
    fn every_cli_accepts_only_its_supported_settings() {
        for agent in crate::services::agent_registry::AGENTS {
            let cap = capabilities(agent.bin);
            let mut tab = opts(agent.bin, &[]);
            apply_in(&mut tab, &settings(agent.bin, "model", "not-an-effort"));
            assert_eq!(
                !tab.args.is_empty()
                    || tab.env.contains_key("GOOSE_MODEL")
                    || tab.env.contains_key("VIBE_ACTIVE_MODEL"),
                cap.model,
                "{}",
                agent.bin
            );
            assert!(!tab.args.iter().any(|s| s.contains("not-an-effort")));
        }
    }

    #[test]
    fn empty_and_invalid_values_leave_the_cli_in_charge() {
        for model in ["", "--help", "model\n--flag"] {
            let mut tab = opts("claude", &[]);
            apply_in(&mut tab, &settings("claude", model, ""));
            assert!(tab.args.is_empty());
        }
        // A cwd flag is not a resume flag for these CLIs.
        let mut cline = opts("cline", &["-c", "folder"]);
        apply_in(&mut cline, &settings("cline", "model", ""));
        assert_eq!(cline.args, ["-c", "folder", "--model", "model"]);
    }

    #[test]
    fn a_phone_save_touches_only_its_own_cli_and_refuses_what_the_form_does() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(
            &path,
            json!({"rev": 4, "language": "de", "a_later_key": [1], "agent_launch_defaults": {"claude": {"model": "opus", "effort": "high"}}})
                .to_string(),
        )
        .unwrap();
        let saved = Saved { model: " gpt-5 ".into(), effort: "ultra".into() };
        save_in(&path, "codex", &saved).unwrap();
        let settings: Settings = crate::storage::read_json(&path).unwrap();
        assert_eq!(settings.rev, 5);
        assert_eq!(settings.language.as_deref(), Some("de"));
        assert_eq!(settings.extra["a_later_key"], json!([1]));
        assert_eq!(saved_in(&settings, "codex"), Saved { model: "gpt-5".into(), effort: "ultra".into() });
        assert_eq!(saved_in(&settings, "claude"), Saved { model: "opus".into(), effort: "high".into() });

        save_in(&path, "claude", &Saved::default()).unwrap();
        let settings: Settings = crate::storage::read_json(&path).unwrap();
        assert_eq!(saved_in(&settings, "claude"), Saved::default());
        assert!(settings.extra["agent_launch_defaults"].get("claude").is_none());

        let refused = |cmd: &str, model: &str, effort: &str| {
            save_in(&path, cmd, &Saved { model: model.into(), effort: effort.into() }).unwrap_err()
        };
        assert_eq!(refused("codex", "--yolo", ""), "invalid_model");
        assert_eq!(refused("codex", "a\nb", ""), "invalid_model");
        assert_eq!(refused("claude", "", "ultra"), "invalid_effort");
        assert_eq!(refused("junie", "", "high"), "effort_needs_model");
        assert_eq!(refused("hermes", "x", ""), "invalid_model");
        assert_eq!(stem(&std::path::Path::new("bin").join("claude.exe").to_string_lossy()), "claude");
    }
}

//! The chat assistant's launches as a phone sees them
//! (`docs/assistant_plan.md`, decision 12, A5/S5a).
//!
//! The phone never names a CLI or a model: `launch-options` lists *launches*,
//! each under an opaque id derived from the host key (`discovery::key_id`,
//! domain `assistant`, the value `"<cli id>"` or `"<cli id>:<model>"`), and a
//! create sends one id back in `CreateTabRequest.assistant`. The sidecar (or
//! the window's bridge, which derives the same ids from
//! `discovery::opaque_control_id`) resolves it against the options the desktop
//! itself would offer ([`crate::commands::assistant::AssistantOptions`]), so an
//! id this module did not derive resolves to nothing. What crosses the browser
//! API is a label, a model name Ollama itself lists, and two flags — never a
//! path, a command, a profile's argv or a tab uid.

use serde::Serialize;

use super::discovery::key_id;
use crate::commands::assistant::AssistantOptions;
use crate::services::assistant::{AssistantCli, AssistantLaunch};

/// The most local models one answer lists (the local-model sheet caps the same).
pub const MAX_MODELS: usize = 64;

/// The domain `launch_handle` derives in; one of
/// `discovery::valid_opaque_control_domain`'s.
pub const DOMAIN: &str = "assistant";

/// One launch the phone's new-chat sheet may offer.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PhoneLaunch {
    /// The opaque id a create sends back.
    pub id: String,
    /// The CLI's name ("Claude", "Codex", "OpenCode").
    pub label: String,
    /// Runs on a local Ollama model, named by `model`.
    pub local: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// A chat can start now (the CLI is installed and signed in, or Ollama is
    /// reachable); the phone dims a launch that is not.
    pub ready: bool,
    /// The desktop's saved default (`assistant_settings`); at most one launch.
    pub default: bool,
}

/// What `launch-options` carries for the assistant scope under `assistant`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PhoneOptions {
    pub launches: Vec<PhoneLaunch>,
    /// Ollama answered, so local launches can be listed at all.
    pub ollama_reachable: bool,
}

/// A launch the host can resolve a handle to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Choice {
    pub public: PhoneLaunch,
    pub launch: AssistantLaunch,
    /// The CLI's binary is installed: only these are listed, but a handle for
    /// any other still resolves (the spawn then refuses with its own reason).
    pub installed: bool,
}

/// The value the opaque id is derived from: `"<cli id>"`, or
/// `"<cli id>:<model>"` for a local profile. A CLI id holds no `:`, so the
/// first one splits it.
pub fn handle_value(cli: AssistantCli, model: Option<&str>) -> String {
    match model {
        Some(model) => format!("{}:{model}", cli.id()),
        None => cli.id().to_string(),
    }
}

/// The opaque id of a launch under `host_key`. The window derives the same
/// through `opaque_control_id(state_dir, "assistant", handle_value(..))`.
pub fn launch_handle(host_key: &[u8], cli: AssistantCli, model: Option<&str>) -> String {
    key_id(host_key, DOMAIN, &[&handle_value(cli, model)])
}

/// Every launch `options` allows, in the desktop menu's order: a cloud CLI
/// once, a local CLI once per installed Ollama model. A CLI the options name
/// but this build does not know or no longer lists, a local one without Ollama, and a model name
/// that is not a safe CLI argument (`model_name_ok`) are skipped.
pub fn choices(host_key: &[u8], options: &AssistantOptions) -> Vec<Choice> {
    let mut out: Vec<Choice> = Vec::new();
    let models: Vec<&String> = options
        .local_models
        .iter()
        .filter(|model| crate::commands::ollama::model_name_ok(model))
        .take(MAX_MODELS)
        .collect();
    for option in &options.clis {
        let Some(cli) = AssistantCli::from_id(&option.id).filter(|cli| crate::services::assistant::is_listed(*cli)) else {
            continue;
        };
        let wanted: Vec<Option<&str>> = if cli.is_local() {
            if !options.ollama_reachable {
                continue;
            }
            models.iter().map(|model| Some(model.as_str())).collect()
        } else {
            vec![None]
        };
        for model in wanted {
            let default = options.default_cli.as_deref() == Some(cli.id())
                && (model.is_none() || options.default_model.is_none() || options.default_model.as_deref() == model)
                && !out.iter().any(|choice| choice.public.default);
            out.push(Choice {
                public: PhoneLaunch {
                    id: launch_handle(host_key, cli, model),
                    label: cli.label().to_string(),
                    local: cli.is_local(),
                    model: model.map(str::to_string),
                    ready: option.ready,
                    default,
                },
                launch: AssistantLaunch { cli, model: model.map(str::to_string) },
                installed: option.installed,
            });
        }
    }
    out
}

/// The `assistant` block of `launch-options`: the installed launches.
pub fn phone_options(host_key: &[u8], options: &AssistantOptions) -> PhoneOptions {
    PhoneOptions {
        launches: choices(host_key, options)
            .into_iter()
            .filter(|choice| choice.installed)
            .map(|choice| choice.public)
            .collect(),
        ollama_reachable: options.ollama_reachable,
    }
}

/// The launch an opaque `handle` stands for, among `choices`.
pub fn resolve(choices: &[Choice], handle: &str) -> Option<AssistantLaunch> {
    choices.iter().find(|choice| choice.public.id == handle).map(|choice| choice.launch.clone())
}

/// A fixed answer of the desktop's options command, for tests here and in the host.
#[cfg(test)]
use crate::commands::assistant::{CliOption, SearchState};

#[cfg(test)]
fn fixture_cli(id: &str, local: bool, installed: bool, ready: bool) -> CliOption {
    CliOption {
        id: id.into(),
        label: id.into(),
        local,
        installed,
        signed_in: (!local).then_some(ready),
        ready,
        models: Vec::new(),
    }
}

#[cfg(test)]
pub(crate) fn fixture_options() -> AssistantOptions {
    AssistantOptions {
        clis: vec![
            fixture_cli("claude", false, true, true),
            fixture_cli("codex", false, true, true),
            fixture_cli("opencode_local", true, true, true),
            fixture_cli("claude_local", true, true, false),
            fixture_cli("future_cli", false, true, true),
        ],
        local_models: vec!["qwen3:8b".into(), "--evil".into(), "llama3.2".into()],
        ollama_reachable: true,
        default_cli: Some("opencode_local".into()),
        default_model: Some("llama3.2".into()),
        search: SearchState {
            kind: None,
            searxng_url: None,
            ollama_key_stored: None,
            keyring: "unlocked",
            configured: false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: [u8; 32] = [9; 32];

    #[test]
    fn launches_are_listed_per_cli_and_model_under_opaque_ids() {
        let mut options = fixture_options();
        let all = choices(&KEY, &options);
        let names: Vec<_> = all.iter().map(|c| (c.launch.cli.id(), c.launch.model.as_deref())).collect();
        assert_eq!(
            names,
            [
                ("codex", None),
                ("opencode_local", Some("qwen3:8b")),
                ("opencode_local", Some("llama3.2")),
                ("claude_local", Some("qwen3:8b")),
                ("claude_local", Some("llama3.2")),
            ],
            "an unknown CLI, an unlisted one (cloud Claude) and an unsafe model name are not offered"
        );
        // Listed: only what is installed. A not-installed CLI still resolves.
        options.clis[1].installed = false;
        let listed = phone_options(&KEY, &options);
        assert!(listed.ollama_reachable);
        assert_eq!(listed.launches.len(), 4);
        assert!(listed.launches.iter().all(|l| l.label != "Codex"));
        let ids: std::collections::HashSet<_> = all.iter().map(|c| c.public.id.clone()).collect();
        assert_eq!(ids.len(), all.len(), "one id per launch");
        // The id is opaque: nothing of the CLI or the model is in it.
        for choice in &all {
            assert!(!choice.public.id.contains("claude") && !choice.public.id.contains("qwen"), "{}", choice.public.id);
            assert_eq!(resolve(&all, &choice.public.id).as_ref(), Some(&choice.launch));
        }
        assert_eq!(resolve(&all, "claude"), None, "a raw cli id is not a handle");
        assert_eq!(resolve(&all, &launch_handle(&[1; 32], AssistantCli::Claude, None)), None, "another host key");
        // Exactly the saved default is flagged, with its model.
        let defaults: Vec<_> = listed.launches.iter().filter(|l| l.default).collect();
        assert_eq!(defaults.len(), 1);
        assert_eq!((defaults[0].label.as_str(), defaults[0].model.as_deref()), ("OpenCode", Some("llama3.2")));
        // `ready` is the CLI's own.
        assert!(listed.launches.iter().find(|l| l.label == "Claude" && l.local).is_some_and(|l| !l.ready));
    }

    #[test]
    fn local_launches_need_ollama() {
        let mut options = fixture_options();
        options.ollama_reachable = false;
        options.local_models.clear();
        let all = choices(&KEY, &options);
        assert!(all.iter().all(|c| !c.public.local));
        assert_eq!(all.len(), 1);
    }

    #[test]
    fn the_handle_is_the_one_the_window_derives() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("mobile-control")).unwrap();
        std::fs::write(dir.path().join("mobile-control/host.key"), KEY).unwrap();
        for (cli, model) in [(AssistantCli::Codex, None), (AssistantCli::OpenCodeLocal, Some("qwen3:8b"))] {
            assert_eq!(
                super::super::discovery::opaque_control_id(dir.path(), DOMAIN, &handle_value(cli, model)).unwrap(),
                launch_handle(&KEY, cli, model)
            );
        }
        assert_eq!(handle_value(AssistantCli::ClaudeLocal, Some("a:b")), "claude_local:a:b");
    }

    #[test]
    fn what_crosses_is_a_label_a_model_name_and_flags() {
        let json = serde_json::to_value(phone_options(&KEY, &fixture_options())).unwrap();
        let launch = &json["launches"][2];
        let mut keys: Vec<_> = launch.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["default", "id", "label", "local", "model", "ready"]);
        assert!(json["launches"][0].get("model").is_none());
    }
}

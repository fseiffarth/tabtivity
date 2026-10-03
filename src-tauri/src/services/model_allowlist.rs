//! The admin-allowed model list — hosted plan §3.3, user decision 2026-10-03.
//!
//! One Ollama per server, and only the admin pulls, loads or deletes models
//! (`command_class`: those commands are `admin`). But Ollama loads whatever a
//! request names, so a user's `core` request — a completion, a local-model tab,
//! the Vibe alias — is held to an allowlist **here, server-side**, before the
//! dispatcher calls the body and the request leaves the daemon. A UI filter
//! would not do: the browser is the user's.
//!
//! The list is `Settings.ollama_allowed_models`. Unset means "what the admin
//! pulled": the admin's own `pull_ollama_model` is the act of allowing, so the
//! default allows every installed model and nothing else — a request for a
//! model that is not on disk is refused, never forwarded for Ollama to look up.
//! An empty list allows nothing.
//!
//! Only the dispatcher calls [`check`]; the desktop window never does (server
//! mode is additive, P2). The commands and the argument that names the model
//! are listed in [`MODEL_ARG`]; a new command that forwards a model name to
//! Ollama gets a row there, or it ships unchecked.

use serde_json::Value;

/// `(command, the argument that names the model)` for every `core` command
/// whose body forwards that name to Ollama.
pub const MODEL_ARG: &[(&str, &str)] = &[
    ("complete_text", "model"),
    ("prepare_local_agent", "model"),
    ("prepare_local_launch", "model"),
    ("ensure_vibe_ollama_model", "model"),
];

/// Where the allowlist and the installed set come from; a seam so the check
/// is testable without a settings file or an Ollama.
pub struct Source<'a> {
    /// `Settings.ollama_allowed_models`.
    pub allowed: Option<&'a [String]>,
    /// What `/api/tags` lists right now (`None` when Ollama is unreachable).
    pub installed: Option<&'a [String]>,
}

/// Is `model` allowed under `source`? An explicit list decides alone; without
/// one, the installed set is the list; with neither, nothing is allowed.
pub fn allowed_in(source: &Source<'_>, model: &str) -> bool {
    let model = model.trim();
    if model.is_empty() {
        return false;
    }
    match source.allowed {
        Some(list) => list.iter().any(|m| same_model(m, model)),
        None => source
            .installed
            .is_some_and(|list| list.iter().any(|m| same_model(m, model))),
    }
}

/// `llama3` names `llama3:latest`, as Ollama itself resolves it.
fn same_model(listed: &str, asked: &str) -> bool {
    let listed = listed.trim();
    listed == asked
        || listed.strip_suffix(":latest") == Some(asked)
        || asked.strip_suffix(":latest") == Some(listed)
}

/// The argument of `cmd` that names a model, if it has one.
pub fn model_arg_of(cmd: &str) -> Option<&'static str> {
    MODEL_ARG.iter().find(|(c, _)| *c == cmd).map(|(_, arg)| *arg)
}

/// The refusal a request for a model outside the list gets. Wire shape
/// `{code:"model-not-allowed", model}`, so the frontend can say which.
pub fn refusal(model: &str) -> Value {
    serde_json::json!({ "code": "model-not-allowed", "model": model })
}

/// The dispatcher's hook: `Ok` when `cmd` names no model or names an allowed
/// one; the refusal otherwise. Reads the settings file and asks Ollama for the
/// installed set only for the commands in [`MODEL_ARG`].
pub fn check(cmd: &str, args: &Value) -> Result<(), Value> {
    let Some(arg) = model_arg_of(cmd) else { return Ok(()) };
    let model = args.get(arg).and_then(Value::as_str).unwrap_or("");
    let settings: crate::schema::Settings =
        crate::storage::read_json(&crate::storage::state_dir().join("settings.json")).unwrap_or_default();
    let installed: Option<Vec<String>> = if settings.ollama_allowed_models.is_some() {
        None
    } else {
        crate::commands::ollama::installed_model_names().ok()
    };
    let source = Source {
        allowed: settings.ollama_allowed_models.as_deref(),
        installed: installed.as_deref(),
    };
    if allowed_in(&source, model) {
        Ok(())
    } else {
        Err(refusal(model))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn an_explicit_list_decides_alone() {
        let allowed = names(&["qwen3:8b", "llama3"]);
        let installed = names(&["qwen3:8b", "gemma:2b"]);
        let source = Source { allowed: Some(&allowed), installed: Some(&installed) };
        assert!(allowed_in(&source, "qwen3:8b"));
        assert!(allowed_in(&source, "llama3:latest"), "a bare name allows its :latest");
        assert!(!allowed_in(&source, "gemma:2b"), "installed but not listed");
        assert!(!allowed_in(&source, ""));
    }

    #[test]
    fn without_a_list_the_admins_pulls_are_the_list() {
        let installed = names(&["qwen3:8b"]);
        let source = Source { allowed: None, installed: Some(&installed) };
        assert!(allowed_in(&source, "qwen3:8b"));
        assert!(!allowed_in(&source, "mistral:7b"));
        let dark = Source { allowed: None, installed: None };
        assert!(!allowed_in(&dark, "qwen3:8b"), "an unreachable Ollama allows nothing");
        let empty: Vec<String> = Vec::new();
        let none = Source { allowed: Some(&empty), installed: Some(&installed) };
        assert!(!none.allowed.unwrap().is_empty() || !allowed_in(&none, "qwen3:8b"));
    }

    #[test]
    fn every_listed_command_is_a_registered_core_command() {
        use crate::services::command_class::{class_of, CommandClass};
        for (cmd, _) in MODEL_ARG {
            assert_eq!(class_of(cmd), Some(CommandClass::Core), "{cmd}");
        }
        assert_eq!(model_arg_of("complete_text"), Some("model"));
        assert_eq!(model_arg_of("pty_write"), None);
        assert_eq!(refusal("x")["code"], "model-not-allowed");
    }
}

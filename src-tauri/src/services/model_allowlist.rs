//! The admin-allowed model list — hosted plan §3.3, user decision 2026-10-03.
//!
//! One Ollama per server, and only the admin pulls, loads or deletes models
//! (`command_class`: those commands are `admin`). But Ollama loads whatever a
//! request names, so every request a server user's daemon makes that names a
//! model is held to an allowlist **here, server-side, at the request**, before
//! it leaves the daemon. A UI filter would not do — the browser is the
//! user's — and neither would guarding the settings: `patch_settings` is
//! `core` (the browser's only settings write) and users legitimately choose
//! among the allowed models, so the model a request names is checked, not the
//! setting it came from (final review A1).
//!
//! The list is the admin's policy (`policy.json` `ollama_allowed_models`,
//! which no user can write). Unset means "what the admin pulled": the admin's
//! own `pull_ollama_model` is the act of allowing, so the default allows every
//! model installed on the shared Ollama and nothing else — a request for a
//! model that is not on disk is refused, never forwarded for Ollama to look
//! up. An empty list allows nothing. The installed list comes from the shared
//! Ollama only (`commands::ollama::host_setting` pins the endpoint on a
//! server), within [`TAGS_TIMEOUT`], cached for [`TAGS_TTL`].
//!
//! Server only: off a server [`check_model`] allows everything (the desktop's
//! owner is its admin; the window and its sidecar are unchanged). The callers:
//! * the dispatcher, through [`check_off_thread`], for the commands in
//!   [`MODEL_ARG`] — a new command that forwards a model name to Ollama gets
//!   a row there, or it ships unchecked;
//! * `services::mail_ai::chat` (summaries, drafts, events, tasks, and the
//!   classifier an inbox sync runs);
//!
//! The root MCP's local-model lane, served by a server daemon too (#2339),
//! forwards no model to Ollama: `ollama_mcp_models` only picks which local
//! models' Vibe configs name the MCP servers; the tab's own model is checked
//! where a launch names it (the `prepare_local_*` rows of [`MODEL_ARG`]). Its recorded endpoint is the shared Ollama, since a server ignores
//! `ollama_host`.

use serde_json::Value;

/// `(command, the argument that names the model)` for every `core` command
/// whose body forwards that name to Ollama, or otherwise acts on that model.
pub const MODEL_ARG: &[(&str, &str)] = &[
    ("complete_text", "model"),
    ("prepare_local_agent", "model"),
    ("prepare_local_launch", "model"),
    ("ensure_vibe_ollama_model", "model"),
    // Forwards nothing to Ollama, but names a model (AGENTS.md): on a server a
    // user clears only an allowed model's conversations.
    ("clear_local_model_conversations", "model"),
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

/// How long the installed-model question may take (after Ollama's bounded
/// connect). Short: it stands in front of a user's request.
pub const TAGS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// How long one answer about the installed models is reused — an
/// autocomplete fires per editing pause, an inbox sync per message.
pub const TAGS_TTL: std::time::Duration = std::time::Duration::from_secs(5);

/// The dispatcher's hook: `Ok` when `cmd` names no model or names an allowed
/// one; the refusal otherwise.
pub fn check(cmd: &str, args: &Value) -> Result<(), Value> {
    let Some(arg) = model_arg_of(cmd) else { return Ok(()) };
    check_model(args.get(arg).and_then(Value::as_str).unwrap_or(""))
}

/// [`check`] for the async dispatcher: off the runtime's workers (it may ask
/// Ollama, a blocking socket), and bounded — a wedged Ollama answers
/// `{code:"ollama-unreachable"}` instead of parking a worker. Free (no thread)
/// for every command that names no model, and off a server.
pub async fn check_off_thread(cmd: &str, args: &Value) -> Result<(), Value> {
    let Some(arg) = model_arg_of(cmd) else { return Ok(()) };
    if !crate::services::server::is_server() {
        return Ok(());
    }
    let model = args.get(arg).and_then(Value::as_str).unwrap_or("").to_string();
    let job = tokio::task::spawn_blocking(move || check_model(&model));
    match tokio::time::timeout(TAGS_TIMEOUT * 3, job).await {
        Ok(Ok(result)) => result,
        _ => Err(unreachable_refusal()),
    }
}

/// Is a request naming `model` allowed to reach the shared Ollama? Always on
/// the desktop; on a server, by the admin's list, else by what is installed.
/// Blocking (it may ask Ollama, briefly): call it off an async worker.
pub fn check_model(model: &str) -> Result<(), Value> {
    if !crate::services::server::is_server() {
        return Ok(());
    }
    let allowed = crate::services::server::server_policy().and_then(|policy| policy.ollama_allowed_models);
    let installed = if allowed.is_some() { None } else { installed_cached() };
    let source = Source {
        allowed: allowed.as_deref(),
        installed: installed.as_deref(),
    };
    if allowed_in(&source, model) {
        Ok(())
    } else {
        Err(refusal(model))
    }
}

/// The refusal when the installed list could not be had in time.
pub fn unreachable_refusal() -> Value {
    serde_json::json!({ "code": "ollama-unreachable" })
}

/// When the installed list was last asked for, and its answer.
type TagsCache = Option<(std::time::Instant, Option<Vec<String>>)>;

/// The shared Ollama's installed models, reused for [`TAGS_TTL`] (an
/// unreachable Ollama too, so a dead one is not asked per request).
fn installed_cached() -> Option<Vec<String>> {
    use std::sync::Mutex;
    use std::time::Instant;
    static CACHE: Mutex<TagsCache> = Mutex::new(None);
    cached_with(&CACHE, Instant::now(), || crate::commands::ollama::installed_model_names_within(TAGS_TIMEOUT).ok())
}

/// [`installed_cached`]'s cache rule, with the clock and the fetch passed in.
fn cached_with(
    cache: &std::sync::Mutex<TagsCache>,
    now: std::time::Instant,
    fetch: impl FnOnce() -> Option<Vec<String>>,
) -> Option<Vec<String>> {
    let mut slot = cache.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some((at, list)) = slot.as_ref() {
        if now.saturating_duration_since(*at) < TAGS_TTL {
            return list.clone();
        }
    }
    let list = fetch();
    *slot = Some((now, list.clone()));
    list
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
    fn the_installed_list_is_reused_within_its_ttl_and_asked_again_after() {
        use std::time::{Duration, Instant};
        let cache = std::sync::Mutex::new(None);
        let t0 = Instant::now();
        let mut asked = 0;
        let mut fetch = |answer: Option<Vec<String>>| {
            asked += 1;
            answer
        };
        assert_eq!(cached_with(&cache, t0, || fetch(None)), None, "an unreachable Ollama allows nothing");
        assert_eq!(cached_with(&cache, t0 + Duration::from_secs(1), || fetch(Some(names(&["a"])))), None, "…and is not asked again at once");
        assert_eq!(cached_with(&cache, t0 + TAGS_TTL, || fetch(Some(names(&["a"])))), Some(names(&["a"])));
        assert_eq!(asked, 2);
    }

    #[test]
    fn off_a_server_every_model_is_allowed_without_asking_ollama() {
        assert!(check_model("anything:at-all").is_ok());
        assert!(check("complete_text", &serde_json::json!({ "model": "x" })).is_ok());
        assert_eq!(unreachable_refusal()["code"], "ollama-unreachable");
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

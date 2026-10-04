//! Local models from the phone (`docs/mobile_local_model_control_plan.md`):
//! the sidecar's half of listing the desktop's Ollama models and loading,
//! unloading or starting them.
//!
//! All the work runs in the desktop window, over the desktop bridge
//! (`lib/mobileLocalModels.ts`), so every desktop surface shows a load the
//! phone started. The sidecar never talks to Ollama itself and has no headless
//! answer: with no window, the phone is told to open the app. What it does
//! here is refuse early — the host-wide switch, any action but load / unload /
//! start, a malformed model name — and shape the window's answer before it
//! crosses: model names and the listed fields only, never a path, a command or
//! an error's text.
//!
//! Downloading, updating and deleting stay desktop-only. There is no route,
//! request variant or bridge path for them; a `pull` is refused here as
//! `unsupported_action` and cannot be deserialized as a
//! [`LocalModelAction`] on either side.

use std::{fs, path::Path};

use axum::http::StatusCode;
use serde_json::{json, Map, Value};

use super::protocol::{LocalModelAction, MobileLocalModel};

/// Most rows one answer carries (the window caps it too).
pub const MAX_MODELS: usize = 64;
/// Longest model reference accepted, in bytes.
pub const MAX_MODEL_REF: usize = 200;
/// Longest `parameter_size` / `quantization` label passed on, in characters.
const MAX_LABEL: usize = 32;

const SERVER_STATES: [&str; 5] = ["running", "starting", "stopped", "unreachable", "not_installed"];
const MODEL_STATES: [&str; 4] = ["idle", "loading", "loaded", "failed"];

/// Whether the host-wide switch is on: `[MOBILE_HOST_KEY].local_models` in
/// `settings.json`, read per request like `files::files_open` so turning it
/// off on the desktop closes the routes at once. Unset is **on** (like
/// `mail_read`); only an explicit `false` closes it. A missing or unreadable
/// settings file closes it too — fail closed.
pub fn local_models_open(state_dir: &Path) -> bool {
    let Some(settings) = fs::read(state_dir.join("settings.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .filter(Value::is_object)
    else {
        return false;
    };
    settings
        .get(crate::brand::MOBILE_HOST_KEY)
        .and_then(|host| host.get("local_models"))
        != Some(&Value::Bool(false))
}

/// A model reference the phone may name: 1–200 bytes of
/// `[A-Za-z0-9._:/@-]` (the desktop's `validate_model_name` charset), no
/// leading `/` and no `..`. The charset already excludes whitespace and
/// control characters.
pub fn valid_model_ref(model: &str) -> bool {
    (1..=MAX_MODEL_REF).contains(&model.len())
        && !model.starts_with('/')
        && !model.contains("..")
        && model
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':' | b'/' | b'@'))
}

/// The phone's `{ "action": "load" | "unload" | "start", "model"?: string }`.
///
/// Any other action — `pull`, `delete`, `copy`, an empty string — is
/// `unsupported_action`, decided before anything else is looked at. A load or
/// unload without a valid model, a start carrying a `model` (serde would let
/// that through on the unit variant), any other key, or a body that is not an
/// object with a string `action` is `invalid_request`.
pub fn parse_action(body: &Value) -> Result<LocalModelAction, &'static str> {
    let fields = body.as_object().ok_or("invalid_request")?;
    let action = fields.get("action").and_then(Value::as_str).ok_or("invalid_request")?;
    if !matches!(action, "load" | "unload" | "start") {
        return Err("unsupported_action");
    }
    if fields.keys().any(|key| key != "action" && key != "model") {
        return Err("invalid_request");
    }
    let model = fields.get("model");
    if action == "start" {
        return match model {
            None => Ok(LocalModelAction::Start),
            Some(_) => Err("invalid_request"),
        };
    }
    let model = model
        .and_then(Value::as_str)
        .filter(|model| valid_model_ref(model))
        .ok_or("invalid_request")?
        .to_string();
    Ok(if action == "load" {
        LocalModelAction::Load { model }
    } else {
        LocalModelAction::Unload { model }
    })
}

/// A display label, without control characters and cut to [`MAX_LABEL`]
/// characters; nothing left is `null`.
fn label(value: Option<&str>) -> Value {
    let text: String = value
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_LABEL)
        .collect();
    let text = text.trim();
    if text.is_empty() {
        Value::Null
    } else {
        Value::String(text.to_string())
    }
}

fn row(model: &MobileLocalModel) -> Value {
    let state = if MODEL_STATES.contains(&model.state.as_str()) { model.state.as_str() } else { "idle" };
    let mut out = Map::new();
    out.insert("name".into(), json!(model.name));
    out.insert("size".into(), json!(model.size));
    out.insert("parameter_size".into(), label(model.parameter_size.as_deref()));
    out.insert("quantization".into(), label(model.quantization.as_deref()));
    out.insert("state".into(), json!(state));
    // Residency means something only while the model is in memory.
    if state == "loaded" {
        let pinned = model.pinned == Some(true);
        out.insert("loaded_size".into(), json!(model.loaded_size.unwrap_or(0)));
        out.insert("vram".into(), json!(model.vram.unwrap_or(0)));
        out.insert("pinned".into(), json!(pinned));
        out.insert("expires_in".into(), if pinned { Value::Null } else { json!(model.expires_in) });
    }
    out.insert("for_tabs".into(), json!(model.for_tabs));
    out.insert("remote".into(), json!(model.remote));
    Value::Object(out)
}

/// The window's `LocalModels` answer as the phone gets it: `server` forced
/// into its five values (anything else is `unreachable`), `can_start` only
/// while `stopped`, `start_failed` never while running or starting; rows
/// whose name is not a valid model reference dropped, then at most
/// [`MAX_MODELS`]; each row's `state` forced into its four values (anything
/// else is `idle`), its labels clamped, and its residency fields kept only
/// while `loaded`. Unknown fields never come through: the rows are rebuilt.
pub fn sanitize(server: &str, can_start: bool, start_failed: bool, models: &[MobileLocalModel]) -> Value {
    let server = if SERVER_STATES.contains(&server) { server } else { "unreachable" };
    let models: Vec<Value> = models
        .iter()
        .filter(|model| valid_model_ref(&model.name))
        .take(MAX_MODELS)
        .map(row)
        .collect();
    json!({
        "server": server,
        "can_start": can_start && server == "stopped",
        "start_failed": start_failed && server != "running" && server != "starting",
        "models": models,
    })
}

/// The HTTP status and the code the phone gets for the window's refusal.
/// Only the codes this feature defines (and the bridge's own) cross as they
/// are; anything else becomes `desktop_error`, so no desktop text ever does.
pub fn refusal(code: &str) -> (StatusCode, &'static str) {
    match code {
        "desktop_unavailable" => (StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"),
        "local_models_disabled" => (StatusCode::FORBIDDEN, "local_models_disabled"),
        "model_not_installed" => (StatusCode::NOT_FOUND, "model_not_installed"),
        "model_not_local" => (StatusCode::BAD_REQUEST, "model_not_local"),
        "model_loading" => (StatusCode::CONFLICT, "model_loading"),
        "ollama_not_running" => (StatusCode::CONFLICT, "ollama_not_running"),
        "start_unavailable" => (StatusCode::CONFLICT, "start_unavailable"),
        // Ollama on the desktop did not answer the window.
        "unreachable" => (StatusCode::BAD_GATEWAY, "unreachable"),
        // A window older than this feature.
        "unknown_request" => (StatusCode::BAD_REQUEST, "unknown_request"),
        // The bridge's own, as every list-answering route forwards them: a
        // write the window made whose fresh list could not be relayed must
        // keep its code, or the phone offers to send it again instead of
        // reloading (`reloadIfApplied` in `api.ts`).
        "applied_response_too_large" => (StatusCode::BAD_REQUEST, "applied_response_too_large"),
        "response_too_large" => (StatusCode::BAD_REQUEST, "response_too_large"),
        _ => (StatusCode::BAD_GATEWAY, "desktop_error"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_settings(dir: &Path, body: &str) {
        fs::write(dir.join("settings.json"), body).expect("write settings");
    }

    #[test]
    fn the_switch_is_on_unless_set_false_and_closed_without_settings() {
        let dir = tempfile::tempdir().expect("state dir");
        assert!(!local_models_open(dir.path()), "missing file fails closed");
        write_settings(dir.path(), "{ not json");
        assert!(!local_models_open(dir.path()), "unparseable file fails closed");
        write_settings(dir.path(), "[]");
        assert!(!local_models_open(dir.path()), "a non-object fails closed");
        let key = crate::brand::MOBILE_HOST_KEY;
        for (settings, open) in [
            (json!({}), true),
            (json!({ key: { "enabled": true } }), true),
            (json!({ key: { "enabled": true, "local_models": true } }), true),
            (json!({ key: { "enabled": true, "local_models": null } }), true),
            (json!({ key: { "enabled": true, "local_models": false } }), false),
        ] {
            write_settings(dir.path(), &settings.to_string());
            assert_eq!(local_models_open(dir.path()), open, "{settings}");
        }
    }

    #[test]
    fn model_refs_follow_the_desktop_charset_with_a_length_cap() {
        let digest = format!("llama3@sha256:{}", "0123abcd".repeat(8));
        for ok in [
            "hf.co/u/m:q4",
            "hf.co/bartowski/Qwen2.5-7B-Instruct-GGUF:Q4_K_M",
            "namespace/model:tag",
            "registry.example.com:5000/ns/model:tag",
            "qwen3.5:9b",
            "llama3",
            "library/llama3:latest",
            "m@sha256",
            &digest,
            "gpt-oss:120b-cloud",
            "phi-4_x",
            &"a".repeat(200),
        ] {
            assert!(valid_model_ref(ok), "{ok} refused");
        }
        for bad in [
            "",
            "..",
            "a/../b",
            "/abs",
            "m\nx",
            "m\0",
            "with space",
            "a\"b",
            "semi;colon",
            "ünï",
            &"a".repeat(201),
        ] {
            assert!(!valid_model_ref(bad), "{bad:?} accepted");
        }
    }

    #[test]
    fn only_load_unload_and_start_parse() {
        assert_eq!(parse_action(&json!({ "action": "load", "model": "llama3" })), Ok(LocalModelAction::Load { model: "llama3".into() }));
        assert_eq!(
            parse_action(&json!({ "action": "unload", "model": "hf.co/u/m:q4" })),
            Ok(LocalModelAction::Unload { model: "hf.co/u/m:q4".into() })
        );
        assert_eq!(parse_action(&json!({ "action": "start" })), Ok(LocalModelAction::Start));

        for action in ["pull", "download", "delete", "remove", "copy", "create", "push", "update", "", "Load", "LOAD"] {
            assert_eq!(parse_action(&json!({ "action": action, "model": "llama3" })), Err("unsupported_action"), "{action}");
            assert_eq!(parse_action(&json!({ "action": action })), Err("unsupported_action"), "{action}");
        }
        // Decided before anything else: an unknown action with stray keys is
        // still the unsupported one.
        assert_eq!(parse_action(&json!({ "action": "pull", "insecure": true })), Err("unsupported_action"));

        for bad in [
            json!({ "action": "load" }),
            json!({ "action": "load", "model": null }),
            json!({ "action": "load", "model": 7 }),
            json!({ "action": "load", "model": "" }),
            json!({ "action": "unload", "model": "../x" }),
            json!({ "action": "load", "model": "a b" }),
            json!({ "action": "load", "model": "x".repeat(201) }),
            json!({ "action": "start", "model": "llama3" }),
            json!({ "action": "start", "model": null }),
            json!({ "action": "load", "model": "llama3", "device": "gpu" }),
            json!({ "action": "start", "extra": 1 }),
            json!({ "model": "llama3" }),
            json!({ "action": 1 }),
            json!(["load"]),
            json!("load"),
            Value::Null,
        ] {
            assert_eq!(parse_action(&bad), Err("invalid_request"), "{bad}");
        }
    }

    fn model(name: &str, state: &str) -> MobileLocalModel {
        MobileLocalModel {
            name: name.into(),
            size: 42,
            parameter_size: Some("9B".into()),
            quantization: Some("Q4_K_M".into()),
            state: state.into(),
            loaded_size: Some(100),
            vram: Some(60),
            pinned: Some(false),
            expires_in: Some(240),
            for_tabs: false,
            remote: false,
        }
    }

    #[test]
    fn sanitize_caps_drops_clamps_and_forces_the_states() {
        let mut models: Vec<MobileLocalModel> = (0..70).map(|n| model(&format!("m{n}:latest"), "idle")).collect();
        models.insert(0, model("../etc/passwd", "idle"));
        models.insert(1, model("/abs", "idle"));
        models.insert(2, model("has space", "idle"));
        let out = sanitize("running", true, true, &models);
        let rows = out["models"].as_array().unwrap();
        assert_eq!(rows.len(), MAX_MODELS);
        assert_eq!(rows[0]["name"], "m0:latest", "invalid names dropped before the cap");
        assert_eq!(out["can_start"], false, "only while stopped");
        assert_eq!(out["start_failed"], false, "never while running");

        let mut long = model("long:latest", "warming_up");
        long.parameter_size = Some(format!("9B\n{}", "x".repeat(60)));
        long.quantization = Some("\u{7}".into());
        let out = sanitize("on_fire", true, true, &[long]);
        assert_eq!(out["server"], "unreachable");
        assert_eq!(out["can_start"], false);
        assert_eq!(out["start_failed"], true);
        let row = &out["models"][0];
        assert_eq!(row["state"], "idle");
        assert_eq!(row["parameter_size"].as_str().unwrap().chars().count(), MAX_LABEL);
        assert!(!row["parameter_size"].as_str().unwrap().contains('\n'));
        assert_eq!(row["quantization"], Value::Null);
        for key in ["loaded_size", "vram", "pinned", "expires_in"] {
            assert!(row.get(key).is_none(), "{key} kept while not loaded: {row}");
        }

        let out = sanitize("stopped", true, true, &[]);
        assert_eq!((out["can_start"].clone(), out["start_failed"].clone()), (json!(true), json!(true)));
        let out = sanitize("starting", true, true, &[]);
        assert_eq!((out["can_start"].clone(), out["start_failed"].clone()), (json!(false), json!(false)));

        let mut pinned = model("q:9b", "loaded");
        pinned.pinned = Some(true);
        pinned.for_tabs = true;
        let out = sanitize("running", false, false, &[model("a:1", "loaded"), pinned]);
        let (timed, kept) = (&out["models"][0], &out["models"][1]);
        assert_eq!(timed["loaded_size"], 100);
        assert_eq!(timed["vram"], 60);
        assert_eq!(timed["pinned"], false);
        assert_eq!(timed["expires_in"], 240);
        assert_eq!(kept["pinned"], true);
        assert_eq!(kept["expires_in"], Value::Null, "a pinned model has no expiry");
        assert_eq!(kept["for_tabs"], true);
        let keys: Vec<&String> = kept.as_object().unwrap().keys().collect();
        assert_eq!(keys.len(), 11, "only the listed fields: {keys:?}");
    }

    #[test]
    fn only_known_refusals_cross_as_themselves() {
        assert_eq!(refusal("desktop_unavailable"), (StatusCode::SERVICE_UNAVAILABLE, "desktop_unavailable"));
        assert_eq!(refusal("local_models_disabled"), (StatusCode::FORBIDDEN, "local_models_disabled"));
        assert_eq!(refusal("model_not_installed"), (StatusCode::NOT_FOUND, "model_not_installed"));
        assert_eq!(refusal("model_not_local"), (StatusCode::BAD_REQUEST, "model_not_local"));
        for code in ["model_loading", "ollama_not_running", "start_unavailable"] {
            assert_eq!(refusal(code), (StatusCode::CONFLICT, code));
        }
        assert_eq!(refusal("unknown_request").0, StatusCode::BAD_REQUEST);
        for code in ["applied_response_too_large", "response_too_large"] {
            assert_eq!(refusal(code), (StatusCode::BAD_REQUEST, code));
        }
        assert_eq!(refusal("unreachable").0, StatusCode::BAD_GATEWAY);
        assert_eq!(refusal("connect ECONNREFUSED 127.0.0.1:11434 /home/u/.ollama"), (StatusCode::BAD_GATEWAY, "desktop_error"));
    }
}

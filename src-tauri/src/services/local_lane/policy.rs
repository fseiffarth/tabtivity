//! What the local lane lets through: pure decisions, no I/O.
//!
//! The host side of the lane treats every byte from the fence as hostile. These
//! functions are the whole rule: which path and method may pass, which models a
//! request names (all of which must be local), how a refusal is worded, and how
//! the two model lists are narrowed to local models.

use serde_json::Value;

/// The API family of a path: a refusal is worded the way that family's clients
/// read an error.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Api {
    /// Ollama's own `/api/*`: `{"error": "…"}`.
    Native,
    /// OpenAI-compatible `/v1/*`: `{"error": {"message", "type"}}`.
    OpenAi,
    /// Anthropic-compatible `/v1/messages`: `{"type": "error", "error": {…}}`.
    Anthropic,
}

/// How a response is narrowed to local models.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Filter {
    /// Passed through as it is, streaming.
    None,
    /// `/api/tags`: entries that name a remote are dropped.
    Tags,
    /// `/v1/models`: ids that are not local models are dropped.
    V1Models,
}

/// A request the lane carries to Ollama.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Route {
    pub path: &'static str,
    pub post: bool,
    /// The body names a model, and every name must pass the local check.
    pub needs_model: bool,
    pub filter: Filter,
    pub api: Api,
}

const fn route(path: &'static str, post: bool, needs_model: bool, filter: Filter, api: Api) -> Route {
    Route { path, post, needs_model, filter, api }
}

/// The only requests the lane carries to Ollama (`docs/local_models_only_plan.md`,
/// 2b). Everything else is refused: notably `pull`, `push`, `create`, `copy`,
/// `delete` and `blobs`, which change what is installed or upload a model.
pub const OLLAMA_ROUTES: &[Route] = &[
    route("/api/chat", true, true, Filter::None, Api::Native),
    route("/api/generate", true, true, Filter::None, Api::Native),
    route("/api/embed", true, true, Filter::None, Api::Native),
    route("/api/embeddings", true, true, Filter::None, Api::Native),
    route("/api/show", true, true, Filter::None, Api::Native),
    route("/api/tags", false, false, Filter::Tags, Api::Native),
    route("/api/ps", false, false, Filter::None, Api::Native),
    route("/api/version", false, false, Filter::None, Api::Native),
    route("/v1/chat/completions", true, true, Filter::None, Api::OpenAi),
    route("/v1/completions", true, true, Filter::None, Api::OpenAi),
    route("/v1/embeddings", true, true, Filter::None, Api::OpenAi),
    route("/v1/models", false, false, Filter::V1Models, Api::OpenAi),
    route("/v1/messages", true, true, Filter::None, Api::Anthropic),
];

/// Why a request does not pass: an HTTP status and the words for the client.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub status: u16,
    pub message: String,
}

impl Refusal {
    pub fn new(status: u16, message: impl Into<String>) -> Refusal {
        Refusal { status, message: message.into() }
    }
}

/// The reason phrase of the statuses the lane answers.
pub fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        411 => "Length Required",
        413 => "Payload Too Large",
        417 => "Expectation Failed",
        431 => "Request Header Fields Too Large",
        501 => "Not Implemented",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Error",
    }
}

/// The path of a request target without its query (a fragment is never sent).
/// `None` for a target that is not an origin-form path: the lane takes no
/// absolute URI, no authority and no `*`.
pub fn target_path(target: &str) -> Option<&str> {
    if !target.starts_with('/') || target.starts_with("//") {
        return None;
    }
    Some(target.split_once('?').map_or(target, |(path, _)| path))
}

/// The route for `method` `target`, or the refusal. The path must match
/// exactly (no trailing slash, no dot segments, no escapes decoded); the query
/// is dropped, so the request that goes upstream is the canonical one.
pub fn ollama_route(method: &str, target: &str) -> Result<Route, Refusal> {
    let path = target_path(target).ok_or_else(|| Refusal::new(400, "This request target is not a plain path."))?;
    let Some(found) = OLLAMA_ROUTES.iter().find(|r| r.path == path) else {
        return Err(Refusal::new(
            403,
            format!(
                "Local models only: `{path}` is not carried to Ollama from this sandbox. Chat, generate, embed, show, tags, ps and version are; installing, copying, creating, pushing or deleting a model is not."
            ),
        ));
    };
    let want = if found.post { "POST" } else { "GET" };
    if method != want {
        return Err(Refusal::new(405, format!("`{path}` takes {want} here.")));
    }
    Ok(*found)
}

/// The JSON error body for `message` in the shape clients of `api` read.
pub fn refusal_body(api: Api, status: u16, message: &str) -> String {
    let kind = if status >= 500 { "api_error" } else { "permission_error" };
    match api {
        Api::Native => serde_json::json!({ "error": message }),
        Api::OpenAi => serde_json::json!({ "error": { "message": message, "type": kind, "code": status } }),
        Api::Anthropic => serde_json::json!({ "type": "error", "error": { "type": kind, "message": message } }),
    }
    .to_string()
}

/// Every model a body names, or why the body cannot be judged. The names the
/// check covers are `model` (and `name` on `/api/show`, the older spelling).
///
/// Ollama's JSON decoder (Go) matches keys without regard to case and takes the
/// last one that matches, so `{"model": "local", "MODEL": "x:cloud"}` runs the
/// cloud model while a plain parse sees the local one: a body that spells the
/// key twice in different cases is refused, as is anything that is not one JSON
/// object, a name that is not a string, or one with surrounding space.
pub fn models_named(route: &Route, body: &[u8]) -> Result<Vec<String>, Refusal> {
    let bad = |why: &str| Refusal::new(400, format!("The request body {why}."));
    let value: Value = serde_json::from_slice(body).map_err(|_| bad("is not one JSON object"))?;
    let Value::Object(map) = value else { return Err(bad("is not one JSON object")) };
    let keys: &[&str] = if route.path == "/api/show" { &["model", "name"] } else { &["model"] };
    let mut names: Vec<String> = Vec::new();
    for key in keys {
        let spellings: Vec<&String> = map.keys().filter(|k| k.to_lowercase() == *key).collect();
        if spellings.len() > 1 || spellings.iter().any(|k| k.as_str() != *key) {
            return Err(bad("spells a model key more than once, or in another letter case"));
        }
        if let Some(spelling) = spellings.first() {
            let Value::String(name) = &map[spelling.as_str()] else { return Err(bad("names a model that is not a string")) };
            if name.is_empty() || name != name.trim() || name.chars().any(char::is_control) {
                return Err(bad("names a model with a blank, padded or control-character name"));
            }
            names.push(name.clone());
        }
    }
    if route.needs_model && names.is_empty() {
        return Err(bad("names no model"));
    }
    Ok(names)
}

/// The verdict of a locality check as a refusal. `verdict` is the string
/// `ollama_client::model_is_local_at` fails with.
pub fn model_refusal(model: &str, verdict: &str) -> Refusal {
    use crate::services::ollama_client as oc;
    match verdict {
        "model_not_local" => Refusal::new(
            403,
            format!("Local models only: `{model}` is an Ollama cloud model; it runs on ollama.com, so this project's agents cannot use it."),
        ),
        oc::MODEL_NOT_RUNNING => Refusal::new(503, "Ollama is not running, so the model could not be checked."),
        oc::LISTENER_REFUSED => Refusal::new(503, "The listener on the Ollama port is not Ollama's, so nothing was sent."),
        _ => Refusal::new(404, format!("model '{model}' is not installed here")),
    }
}

/// `/api/tags` narrowed to local models: an entry that names a remote, or is
/// not an object, is dropped. `Err` for a body that is not a model list (it is
/// not passed on unjudged).
pub fn filter_tags(body: &[u8]) -> Result<Vec<u8>, String> {
    let mut value: Value = serde_json::from_slice(body).map_err(|e| format!("tags: {e}"))?;
    let models = value.get_mut("models").and_then(Value::as_array_mut).ok_or("tags: no model list")?;
    models.retain(|m| m.is_object() && !crate::services::ollama_client::is_remote_entry(m));
    serde_json::to_vec(&value).map_err(|e| format!("tags: {e}"))
}

/// `/v1/models` narrowed to the ids `local` accepts.
pub fn filter_v1_models(body: &[u8], local: &dyn Fn(&str) -> bool) -> Result<Vec<u8>, String> {
    let mut value: Value = serde_json::from_slice(body).map_err(|e| format!("models: {e}"))?;
    let data = value.get_mut("data").and_then(Value::as_array_mut).ok_or("models: no model list")?;
    data.retain(|m| m.get("id").and_then(Value::as_str).is_some_and(local));
    serde_json::to_vec(&value).map_err(|e| format!("models: {e}"))
}

// ── The tools lane ──────────────────────────────────────────────────────────

/// The Tabtivity MCP lanes a cut tab may reach (`docs/local_models_only_plan.md`,
/// 2c): the cockpit (its own tab), the read-only help, and the markup questions.
/// Not the web lane (`/mcp/web`: a page fetch is a way out), git push and release
/// (`/mcp/git`), the schedule, and the root and mail tools (`/mcp`).
pub const MCP_ALLOWED: &[&str] = &["/mcp/cockpit", "/mcp/help", "/mcp/markup"];

/// The MCP path a request may be forwarded to, or the refusal.
pub fn mcp_route(method: &str, target: &str) -> Result<&'static str, Refusal> {
    let path = target_path(target).ok_or_else(|| Refusal::new(400, "This request target is not a plain path."))?;
    let Some(allowed) = MCP_ALLOWED.iter().find(|p| **p == path) else {
        return Err(Refusal::new(
            403,
            format!("Local models only, network cut: `{path}` is not reachable from this sandbox. The cockpit, help and markup tools are."),
        ));
    };
    if method != "POST" {
        return Err(Refusal::new(405, format!("`{path}` takes POST.")));
    }
    Ok(allowed)
}

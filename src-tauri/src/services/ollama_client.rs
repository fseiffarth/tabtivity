//! The Ollama client every local-model feature talks through: where the
//! server is (`Settings::ollama_host`, judged loopback-or-opt-in), whose
//! listener it is (`owner_gate`, and the server this run started), the bounded
//! HTTP/1.0 transport, the digest-keyed capability reads, and the "is this
//! model local?" verdicts the mail assistant and local-model tabs gate on.
//! Moved down from `commands::ollama` (S5), which keeps the Tauri commands and
//! re-exports these names.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

// ── Where the server is ───────────────────────────────────────────────────

/// The endpoint every request here uses when `Settings::ollama_host` says
/// nothing — which is what it said for every install that predates #201a.
pub(crate) const DEFAULT_OLLAMA_ADDR: &str = "127.0.0.1:11434";
pub(crate) const DEFAULT_OLLAMA_PORT: u16 = 11434;

/// The `host:port` this module connects to, per `Settings::ollama_host`.
///
/// Read on every call rather than cached: a settings write is not an event this
/// module hears, and the alternative is a stale endpoint that survives until
/// relaunch. It is one small JSON read against a file the app already keeps hot.
pub(crate) fn ollama_addr() -> Result<String, String> {
    let settings = crate::storage::load_settings().unwrap_or_default();
    let (host, allow_remote) = host_setting(&settings);
    resolve_ollama_addr(host, allow_remote)
}

/// `Settings::ollama_host` and `ollama_allow_remote_host` as this process
/// honours them. On a hosted server neither is a user's to set (final review
/// A2): the endpoint is the one shared Ollama on loopback that the admin runs,
/// so a user's `settings.json` can neither send the daemon's prompts to a
/// host of their choosing, nor aim it at another account's loopback listener,
/// nor make the model allowlist's "installed" list come from a server of
/// their own. The desktop — window and sidecar alike — keeps both settings.
pub(crate) fn host_setting(settings: &crate::schema::Settings) -> (Option<&str>, bool) {
    if crate::services::server::is_server() {
        return (None, false);
    }
    (settings.ollama_host.as_deref(), settings.ollama_allow_remote_host.unwrap_or(false))
}

/// The user's chosen `OLLAMA_MODELS` directory (`Settings::ollama_models_path`),
/// trimmed and dropped when empty. Read on every use for `ollama_addr`'s reason:
/// a settings write is not an event this module hears.
pub(crate) fn configured_models_dir() -> Option<std::path::PathBuf> {
    crate::storage::load_settings()
        .and_then(|s| s.ollama_models_path)
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .map(std::path::PathBuf::from)
}

/// The pure core of [`ollama_addr`]: what the user wrote → what we dial.
///
/// Liberal about spelling (Ollama's own `OLLAMA_HOST` accepts most of these, and
/// the value is usually copied from there) and strict about the two things that
/// change what the feature *is*:
///
/// * **`https://` is an error, never a downgrade.** This transport is a raw
///   `TcpStream` speaking HTTP/1.0; it has no TLS and cannot grow one here.
///   Connecting in the clear to an endpoint the user wrote as TLS would put
///   their prompts on the wire unencrypted while the setting says otherwise —
///   the one failure worth refusing to start for.
/// * **A non-loopback host needs `allow_remote`.** Judged on the literal, not on
///   a resolution: the question is what the user stated, and a name that
///   resolves to loopback today is not a promise about tomorrow. The
///   conservative direction is the safe one — the worst it costs is an opt-in
///   for a hostname that was local anyway.
///
/// `0.0.0.0`/`::` are *bind* addresses, and are the likeliest thing to be pasted
/// in from an `OLLAMA_HOST` that was written for the server side; they are read
/// as loopback rather than refused, since that is both what they mean here and
/// what dialling them would do anyway.
///
/// The result is interpolated into a request line and a `Host:` header, so a
/// host carrying a control character is rejected outright — this builds HTTP by
/// string concatenation, and that is header injection.
pub(crate) fn resolve_ollama_addr(raw: Option<&str>, allow_remote: bool) -> Result<String, String> {
    let raw = raw.map(str::trim).unwrap_or("");
    if raw.is_empty() {
        return Ok(DEFAULT_OLLAMA_ADDR.to_string());
    }

    let rest = if let Some(r) = raw.strip_prefix("http://") {
        r
    } else if let Some(r) = raw.strip_prefix("https://") {
        let _ = r;
        return Err(format!(
            "Ollama host `{raw}` asks for HTTPS, which {app}'s Ollama transport \
             cannot speak — it would have to connect in the clear instead, and \
             sending prompts unencrypted to an address written as `https://` is \
             not something to do quietly. Use `http://` (or drop the scheme) for \
             a server on this machine.", app = crate::brand::DISPLAY
        ));
    } else if let Some((scheme, _)) = raw.split_once("://") {
        return Err(format!(
            "Ollama host `{raw}` names the `{scheme}` scheme; only `http://` (or \
             no scheme at all) is supported."
        ));
    } else {
        raw
    };

    // Drop a path or trailing slash — `http://127.0.0.1:11434/` is what a browser
    // hands you when you copy the address of a running server.
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("").trim();

    // A bare number is a port, not a host — `OLLAMA_HOST=11500` is a spelling
    // Ollama itself documents, so it is the one most likely to be copied across.
    if let Ok(port) = authority.parse::<u16>() {
        return Ok(format!("127.0.0.1:{port}"));
    }

    let (host, port) = split_host_port(authority)
        .ok_or_else(|| format!("Ollama host `{raw}` is not a `host:port` address."))?;

    let host = match host {
        "" => "127.0.0.1",
        // Bind-all pasted into a connect field.
        "0.0.0.0" => "127.0.0.1",
        "::" => "::1",
        h => h,
    };

    if host.is_empty()
        || host
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || c == '\\')
    {
        return Err(format!(
            "Ollama host `{raw}` contains characters a host cannot have."
        ));
    }

    if !host_is_loopback(host) && !allow_remote {
        return Err(format!(
            "Ollama host `{host}` is another machine, so every prompt and every \
             file an agent reads would leave this one. That is off by default for \
             a local-model feature — set `ollama_allow_remote_host` to true in \
             settings.json if it is what you want."
        ));
    }

    Ok(if host.contains(':') {
        // IPv6 literal — the brackets are what keep the port unambiguous.
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    })
}

/// Split an authority into host and port, understanding the bracketed IPv6 form.
/// `None` when the port is present but not a port.
pub(crate) fn split_host_port(authority: &str) -> Option<(&str, u16)> {
    if let Some(rest) = authority.strip_prefix('[') {
        let (host, after) = rest.split_once(']')?;
        return match after {
            "" => Some((host, DEFAULT_OLLAMA_PORT)),
            p => Some((host, p.strip_prefix(':')?.parse().ok()?)),
        };
    }
    // An unbracketed value with more than one colon is a bare IPv6 literal;
    // there is no port in it to find.
    if authority.matches(':').count() > 1 {
        return Some((authority, DEFAULT_OLLAMA_PORT));
    }
    match authority.split_once(':') {
        None => Some((authority, DEFAULT_OLLAMA_PORT)),
        Some((host, "")) => Some((host, DEFAULT_OLLAMA_PORT)),
        Some((host, port)) => Some((host, port.parse().ok()?)),
    }
}

/// How long to wait for the TCP handshake. Nothing to do with the 600 s *read*
/// timeout beside it, which covers a model pull between chunks.
///
/// It exists because `ollama_host` can now name another machine, and a bare
/// `TcpStream::connect` at a host that is off, firewalled or simply mistyped
/// blocks for the OS TCP timeout — minutes — inside a `#[tauri::command]`,
/// which is the window-freeze this repo has already paid for twice (a locked
/// keyring, a disconnected remote project's git reads). A loopback port that
/// nothing is listening on refuses instantly and never reaches this bound, so
/// the default configuration is unchanged.
pub(crate) const OLLAMA_CONNECT_TIMEOUT: Duration = Duration::from_secs(4);

/// Open a connection to an already-resolved `host:port`, bounded.
pub(crate) fn connect_ollama(addr: &str) -> Result<TcpStream, String> {
    use std::net::ToSocketAddrs;
    // `not_running` for every failure, resolution included: it is the sentinel
    // the whole 🧠 surface already branches on, and "the name does not resolve"
    // and "nothing answers" are the same thing to a caller that wants a model.
    addr.to_socket_addrs()
        .ok()
        .and_then(|mut it| {
            it.find_map(|sa| TcpStream::connect_timeout(&sa, OLLAMA_CONNECT_TIMEOUT).ok())
        })
        .ok_or_else(|| "not_running".to_string())
}

/// Whether a host *literal* names this machine. Deliberately no DNS: see
/// [`resolve_ollama_addr`].
pub(crate) fn host_is_loopback(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    match host.parse::<std::net::IpAddr>() {
        Ok(ip) => ip.is_loopback() || ip.is_unspecified(),
        // `foo.localhost` resolves to loopback by convention (RFC 6761).
        Err(_) => host.to_ascii_lowercase().ends_with(".localhost"),
    }
}

// ── Whose listener it is ──────────────────────────────────────────────────

/// The error (prefix) of a loopback listener nobody here vouches for. Judged by
/// [`owner_gate`] before a byte is sent, and told apart from "not running" by
/// [`model_is_local_in`]: the answer would have been another process's.
pub(crate) const LISTENER_REFUSED: &str = "ollama_listener_refused";

/// The uid the user (`Settings::ollama_listener_uid`) or, on a hosted server,
/// the administrator (the server policy file) names as running Ollama.
pub(crate) fn named_listener_uid() -> Option<u32> {
    if crate::services::server::is_server() {
        return crate::services::server::server_policy().and_then(|p| p.ollama_listener_uid);
    }
    crate::storage::load_settings().and_then(|s| s.ollama_listener_uid)
}

/// Refuse a loopback `addr` whose listening socket belongs to someone Ollama
/// would not be: another account, a fenced agent's process, or one that cannot
/// be identified (`services::loopback_owner`, gap 50a). Asked after the
/// connection and before anything is written, and by every "is it local?" gate,
/// so a squatter on the port gets neither prompts, mail nor a say in whether
/// the model is local. No listener, or an address on another machine: nothing
/// to judge. Linux only; elsewhere address-only trust remains.
pub(crate) fn owner_gate(addr: &str) -> Result<(), String> {
    let Some((host, port)) = split_host_port(addr).filter(|(host, _)| host_is_loopback(host)) else { return Ok(()) };
    let policy = crate::services::loopback_owner::Policy::current(named_listener_uid());
    let ours: Vec<u32> = match OWNED_SERVER.lock().ok().as_deref() {
        Some(Some(OwnedServer::Process(pid))) => vec![*pid],
        _ => Vec::new(),
    };
    crate::services::loopback_owner::check(host, port, &policy, &ours)
        .map_err(|refusal| format!("{LISTENER_REFUSED}: {}", refusal.describe(addr)))
}

// ── HTTP helper ───────────────────────────────────────────────────────────

/// Send a request to the local Ollama REST API and return the response body.
/// Uses HTTP/1.0 to avoid chunked transfer encoding.
pub(crate) fn ollama_http(
    method: &str,
    path: &str,
    json_body: Option<&str>,
) -> Result<String, String> {
    // 10-minute timeout accommodates large model pulls
    ollama_http_within(method, path, json_body, Duration::from_secs(600))
}

/// How long a status read (`/api/tags`, `/api/ps`) waits for its answer once
/// connected. Both are answered from what the server already holds, so a
/// server that takes longer is wedged, and the 🧠 lamp, the model list and the
/// phone must say so instead of holding a thread for [`ollama_http`]'s ten
/// minutes (code screen B2). The locality check asks within the same bound.
pub(crate) const STATUS_READ_TIMEOUT: Duration = Duration::from_secs(10);

/// `GET path` against the configured server within [`STATUS_READ_TIMEOUT`].
pub(crate) fn ollama_status_read(path: &str) -> Result<String, String> {
    ollama_http_within("GET", path, None, STATUS_READ_TIMEOUT)
}

/// [`ollama_http`] with its own read timeout, for a quick question that must
/// not hold its thread for a pull's ten minutes.
pub(crate) fn ollama_http_within(
    method: &str,
    path: &str,
    json_body: Option<&str>,
    read_timeout: Duration,
) -> Result<String, String> {
    ollama_http_at(&ollama_addr()?, method, path, json_body, read_timeout)
}

/// [`ollama_http_within`] against an endpoint the caller already resolved —
/// one a tab was spawned with, which today's `ollama_host` may no longer name,
/// or the one the mail assistant's local-model check asked (gap 25).
pub(crate) fn ollama_http_at(
    addr: &str,
    method: &str,
    path: &str,
    json_body: Option<&str>,
    read_timeout: Duration,
) -> Result<String, String> {
    #[cfg(test)]
    if let Some(answer) = test_http::answer(addr, method, path) {
        return answer;
    }
    let mut stream = connect_ollama(addr)?;
    owner_gate(addr)?;
    stream
        .set_read_timeout(Some(read_timeout))
        .map_err(|e| format!("set timeout: {e}"))?;

    let req = match json_body {
        Some(body) => format!(
            "{method} {path} HTTP/1.0\r\nHost: {addr}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        ),
        None => format!("{method} {path} HTTP/1.0\r\nHost: {addr}\r\n\r\n"),
    };

    stream
        .write_all(req.as_bytes())
        .map_err(|e| format!("write: {e}"))?;

    let mut raw = String::new();
    stream
        .read_to_string(&mut raw)
        .map_err(|e| format!("read: {e}"))?;

    let status: u16 = raw
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(200);

    let body = raw.split("\r\n\r\n").nth(1).unwrap_or("").to_owned();

    if status >= 400 {
        let msg = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v["error"].as_str().map(String::from))
            .unwrap_or_else(|| format!("HTTP {status}"));
        return Err(friendly_ollama_error(&msg));
    }

    Ok(body)
}

/// Rewrite a raw Ollama error into a clearer, actionable message for the failure
/// modes that otherwise surface as an opaque HTTP 500 / "internal server error"
/// (e.g. when driven through vibe). Currently detects a broken install whose
/// inference runner (`llama-server`) is missing: Ollama answers API requests but
/// cannot load any model, so every generate/chat call 500s. Unrecognised errors
/// pass through unchanged. Pure + tested.
pub(crate) fn friendly_ollama_error(raw: &str) -> String {
    let lower = raw.to_ascii_lowercase();
    if lower.contains("llama-server") && lower.contains("not found") {
        let cmd = ollama_install_cmd();
        return format!(
            "Ollama's inference runner (llama-server) is missing, so Ollama can \
            serve its API but cannot load any model — the install is incomplete. \
            Reinstall Ollama with `{cmd}`."
        );
    }
    raw.to_string()
}

/// The recommended Ollama install command for the host OS. Kept here so the
/// backend installer, the error messages, and the UI's copy-to-clipboard
/// fallback all stay in sync with whatever the installer actually runs.
///
/// - Windows: winget (present on all supported Windows 10/11 builds).
/// - Linux/macOS: the official distro-agnostic install script.
pub fn ollama_install_cmd() -> &'static str {
    if cfg!(target_os = "windows") {
        "winget install --id Ollama.Ollama -e --silent --accept-source-agreements --accept-package-agreements"
    } else {
        "curl -fsSL https://ollama.com/install.sh | sh"
    }
}

/// Capability lists keyed by *manifest digest*, not by model name. A model's
/// capabilities are fixed by its manifest, so a digest that has been read once
/// can never need re-reading — and a re-pull (the one thing that changes them)
/// changes the digest, which misses the cache by construction. Without this,
/// `list_ollama_models_detailed` — called on every hover of the 🧠 menu, by the
/// editor's autocomplete and by the autoload store — would spend one `/api/show`
/// round trip per installed model per call.
pub(crate) static CAPABILITY_CACHE: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, Vec<String>>>,
> = std::sync::OnceLock::new();

/// Ollama's capability list for `model`, cached against `digest`.
///
/// An empty vec is returned for every failure — an unreachable server, an
/// Ollama predating the `capabilities` field, a malformed body. That is
/// deliberate and every caller must honour it: **empty means "we could not
/// ask", never "this model supports nothing"**. Treating the two alike is what
/// would make a transient probe failure silently hide every agent in the
/// new-tab menu.
pub(crate) fn model_capabilities(model: &str, digest: &str) -> Vec<String> {
    match ollama_addr() {
        Ok(addr) => model_capabilities_at(&addr, model, digest),
        Err(_) => Vec::new(),
    }
}

/// [`model_capabilities`] asked of `addr`, an endpoint the caller resolved.
pub(crate) fn model_capabilities_at(addr: &str, model: &str, digest: &str) -> Vec<String> {
    let cache = CAPABILITY_CACHE.get_or_init(Default::default);
    if !digest.is_empty() {
        if let Ok(map) = cache.lock() {
            if let Some(hit) = map.get(digest) {
                return hit.clone();
            }
        }
    }

    let body = serde_json::json!({ "model": model }).to_string();
    let caps: Vec<String> = ollama_http_at(addr, "POST", "/api/show", Some(&body), Duration::from_secs(600))
        .ok()
        .and_then(|b| serde_json::from_str::<serde_json::Value>(&b).ok())
        .and_then(|v| v["capabilities"].as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|c| c.as_str().map(String::from))
        .collect();

    // Only a positive answer is cached: caching an empty list would freeze a
    // transient failure in for the rest of the session.
    if !digest.is_empty() && !caps.is_empty() {
        if let Ok(mut map) = cache.lock() {
            map.insert(digest.to_string(), caps.clone());
        }
    }
    caps
}

/// The installed models that *do* support tool calls, for the "pick one of
/// these instead" half of a refusal. Read off this machine rather than a
/// hardcoded example list, which would age as the registry moves.
pub(crate) fn tool_capable_models() -> Vec<String> {
    ollama_status_read("/api/tags")
        .ok()
        .and_then(|b| serde_json::from_str::<serde_json::Value>(&b).ok())
        .and_then(|v| v["models"].as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|m| {
            let name = m["name"].as_str()?;
            let digest = m["digest"].as_str().unwrap_or("");
            model_capabilities(name, digest)
                .iter()
                .any(|c| c == "tools")
                .then(|| name.to_string())
        })
        .collect()
}

/// Whether `model` carries `cap` — `Some(false)` only when Ollama positively
/// said so. `None` is "could not tell", which every caller reads as "let it
/// through": see [`model_capabilities`].
pub(crate) fn model_has_capability(model: &str, cap: &str) -> Option<bool> {
    let digest = ollama_status_read("/api/tags")
        .ok()
        .and_then(|b| serde_json::from_str::<serde_json::Value>(&b).ok())
        .and_then(|v| v["models"].as_array().cloned())
        .unwrap_or_default()
        .iter()
        .find(|m| m["name"].as_str() == Some(model))
        .and_then(|m| m["digest"].as_str().map(String::from))
        .unwrap_or_default();

    let caps = model_capabilities(model, &digest);
    if caps.is_empty() {
        return None;
    }
    Some(caps.iter().any(|c| c == cap))
}

/// Ollama's capability list for `model`, resolved through one `/api/tags` read
/// for the manifest digest and the digest-keyed [`model_capabilities`] cache.
///
/// **Empty means "could not ask", never "supports nothing"** — the same rule
/// [`model_capabilities`] documents. `services::mail_ai` reads it to refuse an
/// embedding-only model, and honours the empty-is-unknown contract by allowing
/// through anything it cannot classify.
///
/// Asked of `addr`, the endpoint the caller already resolved and judged
/// (`services::mail_ai` passes the one its local-model check used, so a
/// settings change in between cannot send the probe elsewhere).
pub(crate) fn capabilities_of_at(addr: &str, model: &str) -> Vec<String> {
    let digest = ollama_http_at(addr, "GET", "/api/tags", None, STATUS_READ_TIMEOUT)
        .ok()
        .and_then(|b| serde_json::from_str::<serde_json::Value>(&b).ok())
        .and_then(|v| v["models"].as_array().cloned())
        .unwrap_or_default()
        .iter()
        .find(|m| m["name"].as_str() == Some(model))
        .and_then(|m| m["digest"].as_str().map(String::from))
        .unwrap_or_default();
    model_capabilities_at(addr, model, &digest)
}

/// Whether `model` can drive tool/function calls.
pub(crate) fn model_supports_tools(model: &str) -> Option<bool> {
    model_has_capability(model, "tools")
}

/// Whether `model` can *think* — i.e. Ollama will accept a request carrying a
/// reasoning field. A model without it is not merely non-reasoning: Ollama
/// **rejects the whole request** with `"<model>" does not support thinking`, so
/// an agent that sends a reasoning effort by default (Codex does — its
/// `model_reasoning_effort` defaults to `medium`, and the user's own
/// `~/.codex/config.toml` usually sets it explicitly) dies on its first turn.
pub(crate) fn model_supports_thinking(model: &str) -> Option<bool> {
    model_has_capability(model, "thinking")
}

/// Whether an `/api/tags` entry is an Ollama cloud model: one that names the
/// remote it runs on, or whose tag says so ([`is_cloud_name`]). Nothing about
/// it is on this machine to load. Pure + tested.
pub(crate) fn is_remote_entry(entry: &serde_json::Value) -> bool {
    ["remote_host", "remote_model"]
        .iter()
        .any(|k| entry[*k].as_str().is_some_and(|s| !s.trim().is_empty()))
        || entry["name"].as_str().is_some_and(is_cloud_name)
}

/// Whether a model *name* is one of Ollama's cloud models by its tag
/// (`gpt-oss:120b-cloud`, `qwen3-coder:cloud`): a second opinion beside the
/// list's own `remote_*` fields, so a list that ever stops carrying them
/// still refuses the name. A copy under another name (`ollama cp`) carries
/// no such tag — the list's fields catch that one. Pure + tested.
pub(crate) fn is_cloud_name(model: &str) -> bool {
    let leaf = model.trim().rsplit('/').next().unwrap_or(model);
    let tag = leaf.split('@').next().unwrap_or(leaf).split_once(':').map_or("", |(_, t)| t);
    let tag = tag.to_ascii_lowercase();
    tag == "cloud" || tag.ends_with("-cloud")
}

/// The verdict of [`model_is_local_in`] when `/api/tags` could not be read for
/// want of a server: the 🧠 surface's own sentinel.
pub(crate) const MODEL_NOT_RUNNING: &str = "not_running";

/// Whether `model` runs on this machine, judged from the `/api/tags` answer
/// of the endpoint that will run it (gap 25): `Ok` only for a listed model
/// with no remote — [`installed_match`]'s rule, plus [`is_cloud_name`] before
/// anything is asked. `Err("model_not_local")` for an Ollama cloud model
/// (a loopback Ollama forwards it to ollama.com), `Err("model_not_installed")`
/// for an unlisted name or an unreadable list (fail closed),
/// `Err(MODEL_NOT_RUNNING)` when nothing answered. Pure + tested.
pub(crate) fn model_is_local_in(
    tags: Result<&str, &str>,
    model: &str,
) -> Result<(), &'static str> {
    if is_cloud_name(model) {
        return Err("model_not_local");
    }
    match tags {
        Ok(body) => installed_match(body, model).map(|_| ()),
        // No answer at all — nothing listening, or the connection failed or
        // timed out mid-read — is "not running", never "not installed": the
        // list was not read, so nothing is known about the model (step 5
        // review). An error the server answered (`HTTP 500`) still is.
        Err(e) if e.starts_with(LISTENER_REFUSED) => Err(LISTENER_REFUSED),
        Err(e) if is_transport_failure(e) => Err(MODEL_NOT_RUNNING),
        Err(_) => Err("model_not_installed"),
    }
}

/// Whether an [`ollama_http_at`] error is the transport's — nothing answered,
/// or the exchange broke off (`connect_ollama`'s sentinel, the `write:` /
/// `read:` / `set timeout:` failures) — rather than an error the server sent.
pub(crate) fn is_transport_failure(err: &str) -> bool {
    err == MODEL_NOT_RUNNING || ["read: ", "write: ", "set timeout: "].iter().any(|p| err.starts_with(p))
}

/// The refusal for a tab's model whose alias another installed model shares.
pub(crate) const MODEL_ALIAS_SHARED: &str = "model_alias_shared";

/// [`model_is_local_in`] for a local-model **tab** (`services::root_mcp`):
/// also refuses ([`MODEL_ALIAS_SHARED`]) when another model the endpoint lists
/// has the same alias ([`sanitize_alias`]; `a:b-c` and `a-b:c` share
/// `a-b-c`). A tab's Vibe home and its read-mail taint are keyed by the alias,
/// and the home's `config.toml` names whichever of the two was prepared last,
/// so the tab could be running the other one (step 5 review). Pure + tested.
pub(crate) fn tab_model_is_local_in(tags: Result<&str, &str>, model: &str) -> Result<(), &'static str> {
    model_is_local_in(tags, model)?;
    match tags {
        Ok(body) if alias_shared_in(body, model) => Err(MODEL_ALIAS_SHARED),
        _ => Ok(()),
    }
}

/// Whether a listed model other than the one `model` names answers to
/// `model`'s alias — by its full name, or, for a `:latest` entry, by its bare
/// name (a tab may name `x:latest` as `x`).
pub(crate) fn alias_shared_in(tags_body: &str, model: &str) -> bool {
    let model = model.trim();
    let Ok(matched) = installed_match(tags_body, model) else { return false };
    let alias = sanitize_alias(model);
    let Some(entries) = serde_json::from_str::<serde_json::Value>(tags_body)
        .ok()
        .and_then(|v| v["models"].as_array().cloned())
    else {
        return false;
    };
    entries.iter().filter_map(|m| m["name"].as_str()).filter(|n| *n != matched).any(|name| {
        sanitize_alias(name) == alias || name.strip_suffix(":latest").is_some_and(|bare| sanitize_alias(bare) == alias)
    })
}

/// How long a [`model_is_local_at`] verdict is reused. Auto-classify asks for
/// every new mail; a minute keeps that to one `/api/tags` read per burst.
pub(crate) const LOCALITY_TTL: Duration = Duration::from_secs(60);

/// [`model_is_local_at`]'s (and [`tab_model_is_local_at`]'s: `tab`) answers per
/// `(endpoint, model)`, with when they were read. Only a definite verdict is
/// kept (`Ok`, `model_not_local`): a failed or empty read is asked again next
/// time, so a server that comes up is seen at once. Pure + tested.
#[derive(Default)]
pub(crate) struct LocalityCache(std::collections::HashMap<(String, String, bool), (Instant, Locality)>);

/// One [`model_is_local_in`] verdict.
pub(crate) type Locality = Result<(), &'static str>;

impl LocalityCache {
    pub(crate) fn get(&self, addr: &str, model: &str, tab: bool, now: Instant) -> Option<Locality> {
        self.0
            .get(&(addr.to_owned(), model.to_owned(), tab))
            .filter(|(at, _)| now.saturating_duration_since(*at) < LOCALITY_TTL)
            .map(|(_, verdict)| *verdict)
    }
    pub(crate) fn put(&mut self, addr: &str, model: &str, tab: bool, now: Instant, verdict: Locality) {
        if matches!(verdict, Ok(()) | Err("model_not_local")) {
            self.0.retain(|_, (at, _)| now.saturating_duration_since(*at) < LOCALITY_TTL);
            self.0.insert((addr.to_owned(), model.to_owned(), tab), (now, verdict));
        }
    }
}

pub(crate) fn locality_cache() -> &'static std::sync::Mutex<LocalityCache> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<LocalityCache>> = std::sync::OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// [`model_is_local_in`] against the live `/api/tags` of `addr` — an endpoint
/// the caller already resolved and judged loopback — cached for
/// [`LOCALITY_TTL`]. The one gate between mail text and a model: the mail
/// assistant (`services::mail_ai::chat`) and a local-model tab's mail reads
/// (`services::root_mcp_mail`) both ask it before anything is sent.
pub(crate) fn model_is_local_at(addr: &str, model: &str) -> Result<(), &'static str> {
    locality_at(addr, model, false)
}

/// [`model_is_local_at`] for a local-model tab's recorded model:
/// [`tab_model_is_local_in`]'s rule (no other installed model shares its
/// alias), cached the same way.
pub(crate) fn tab_model_is_local_at(addr: &str, model: &str) -> Result<(), &'static str> {
    locality_at(addr, model, true)
}

pub(crate) fn locality_at(addr: &str, model: &str, tab: bool) -> Result<(), &'static str> {
    let model = model.trim();
    let judge = if tab { tab_model_is_local_in } else { model_is_local_in };
    #[cfg(test)]
    if let Some(tags) = test_tags::current() {
        return judge(tags.as_deref().map_err(String::as_str), model);
    }
    // Before the cache, which would otherwise vouch for a listener that has
    // since been replaced.
    if owner_gate(addr).is_err() {
        return Err(LISTENER_REFUSED);
    }
    let now = Instant::now();
    if let Some(verdict) = locality_cache().lock().unwrap_or_else(|p| p.into_inner()).get(addr, model, tab, now) {
        return verdict;
    }
    let tags = ollama_http_at(addr, "GET", "/api/tags", None, STATUS_READ_TIMEOUT);
    let verdict = judge(tags.as_deref().map_err(String::as_str), model);
    locality_cache().lock().unwrap_or_else(|p| p.into_inner()).put(addr, model, tab, now, verdict);
    verdict
}

/// What [`model_is_local_at`] reads in place of a live `/api/tags` inside a
/// test: unset reads as no server (fail closed), so no test ever asks a real
/// Ollama on the developer's machine. Per thread, like the tests themselves.
#[cfg(test)]
pub(crate) mod test_tags {
    use std::cell::RefCell;
    thread_local! {
        static TAGS: RefCell<Option<Result<String, String>>> = const { RefCell::new(None) };
    }
    pub(crate) fn current() -> Option<Result<String, String>> {
        Some(TAGS.with(|t| t.borrow().clone()).unwrap_or_else(|| Err(super::MODEL_NOT_RUNNING.to_owned())))
    }
    /// Answer `/api/tags` with `body` on this thread (`None`: nothing answers).
    pub(crate) fn set(body: Option<&str>) {
        TAGS.with(|t| *t.borrow_mut() = Some(body.map(str::to_owned).ok_or_else(|| super::MODEL_NOT_RUNNING.to_owned())));
    }
    /// Fail `/api/tags` with the transport error `err` on this thread.
    pub(crate) fn fail(err: &str) {
        TAGS.with(|t| *t.borrow_mut() = Some(Err(err.to_owned())));
    }
}

/// A stand-in for the Ollama HTTP transport inside a test: while a handler is
/// set on the thread, [`ollama_http_at`] asks it instead of dialing, and every
/// request is recorded with the address it was sent to. Unset: the transport
/// behaves as it always does.
#[cfg(test)]
pub(crate) mod test_http {
    use std::cell::RefCell;
    type Handler = Box<dyn Fn(&str, &str, &str) -> Result<String, String>>;
    thread_local! {
        static HANDLER: RefCell<Option<Handler>> = const { RefCell::new(None) };
        static SEEN: RefCell<Vec<(String, String, String)>> = const { RefCell::new(Vec::new()) };
    }
    /// Answer `(addr, method, path)` with `handler` on this thread (`None`: stop).
    pub(crate) fn set(handler: Option<Handler>) {
        HANDLER.with(|h| *h.borrow_mut() = handler);
        SEEN.with(|s| s.borrow_mut().clear());
    }
    pub(crate) fn answer(addr: &str, method: &str, path: &str) -> Option<Result<String, String>> {
        HANDLER.with(|h| {
            let handler = h.borrow();
            let handler = handler.as_ref()?;
            SEEN.with(|s| s.borrow_mut().push((addr.to_owned(), method.to_owned(), path.to_owned())));
            Some(handler(addr, method, path))
        })
    }
    /// The requests answered so far: `(addr, method, path)`.
    pub(crate) fn seen() -> Vec<(String, String, String)> {
        SEEN.with(|s| s.borrow().clone())
    }
}

/// The installed model `wanted` names, as `/api/tags` lists it: an exact match,
/// or `wanted:latest` for an untagged name — never a prefix (`qwen3` is not
/// `qwen3.5:9b`). `Err("model_not_installed")` when nothing matches (an
/// unreadable body included: fail closed), `Err("model_not_local")` for a cloud
/// entry. Returning the *listed* spelling matters: it is the key the load's
/// progress events carry. Pure + tested.
pub(crate) fn installed_match(tags_body: &str, wanted: &str) -> Result<String, &'static str> {
    let tags = serde_json::from_str::<serde_json::Value>(tags_body)
        .map_err(|_| "model_not_installed")?;
    let entries = tags["models"].as_array().ok_or("model_not_installed")?;
    // Untagged means no `:` in the last path segment — a registry's port
    // (`reg:5000/ns/m`) is not a tag, and a digest ref (`m@sha256:…`) is never
    // given one.
    let leaf = wanted.rsplit('/').next().unwrap_or(wanted);
    let latest = (!leaf.contains(':')).then(|| format!("{wanted}:latest"));
    let found = entries.iter().find(|m| {
        m["name"]
            .as_str()
            .is_some_and(|n| n == wanted || latest.as_deref() == Some(n))
    });
    match found {
        None => Err("model_not_installed"),
        Some(m) if is_remote_entry(m) => Err("model_not_local"),
        Some(m) => Ok(m["name"].as_str().unwrap_or(wanted).to_owned()),
    }
}


/// How the Ollama server currently answering came to be running — recorded by
/// [`ensure_ollama_running`] and read by nothing but [`shutdown_owned_server`].
///
/// The whole point is the *absence* of a third variant: a server that was
/// already listening when Tabtivity asked, or one running on another machine, is
/// never recorded, so exit-time teardown cannot reach it. Ollama is a machine
/// service as often as it is a Tabtivity detail — a terminal running `ollama run`,
/// another editor's completion plugin, a unit the user enabled at boot — and
/// killing one Tabtivity merely *used* would take those down with it.
pub(crate) enum OwnedServer {
    /// An `ollama serve` this process spawned (`spawn_reaped`, so the pid is
    /// ours and its subtree is walkable).
    Process(u32),
    /// The systemd unit, which was **inactive** until this run started it. Only
    /// recorded on Linux and only for the default address — the same two
    /// conditions under which it is started.
    #[cfg(target_os = "linux")]
    SystemdUnit,
}

pub(crate) static OWNED_SERVER: std::sync::Mutex<Option<OwnedServer>> = std::sync::Mutex::new(None);

pub(crate) fn record_owned_server(owned: OwnedServer) {
    if let Ok(mut slot) = OWNED_SERVER.lock() {
        // A previous entry can only be a server that has since died (we reach
        // the start paths at all only when nothing is listening), so replacing
        // it is right: the live one is the one worth stopping.
        *slot = Some(owned);
    }
}

/// Stop the Ollama server **this run started**, if any. Called once from
/// `RunEvent::Exit`; a server Tabtivity only talked to is left alone (see
/// [`OwnedServer`]).
///
/// A spawned server is TERMed with its whole subtree — the `ollama runner` child
/// holding the weights is a separate process, and it is the one actually sitting
/// on several GB of VRAM — and given a short blocking grace before SIGKILL, so
/// the ordinary case is a clean shutdown rather than a killed server that leaves
/// its runner behind. The unit is stopped with `--no-block`: exit must not wait
/// on systemd's job queue, and the elevation was already granted on the start
/// that this undoes.
pub fn shutdown_owned_server() {
    let owned = match OWNED_SERVER.lock() {
        Ok(mut slot) => slot.take(),
        Err(_) => return,
    };
    match owned {
        None => {}
        Some(OwnedServer::Process(pid)) => {
            crate::terminal::reap_child_subtree(
                pid,
                crate::terminal::ReapMode::GracefulBlocking(Duration::from_millis(1500)),
            );
        }
        #[cfg(target_os = "linux")]
        Some(OwnedServer::SystemdUnit) => {
            let _ = std::process::Command::new("systemctl")
                .args(["stop", "--no-block", "ollama"])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
    }
}

/// The names `/api/tags` lists, synchronously, answered within `read_timeout`
/// (after the bounded connect), or an error — the dispatcher's model allowlist
/// (`services::model_allowlist`) asks before a request is forwarded.
pub(crate) fn installed_model_names_within(read_timeout: Duration) -> Result<Vec<String>, String> {
    let body = ollama_http_within("GET", "/api/tags", None, read_timeout)?;
    let v: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("ollama json: {e}"))?;

    let models = v["models"]
        .as_array()
        .ok_or("no models field in ollama response")?;

    Ok(models
        .iter()
        .filter_map(|m| Some(m["name"].as_str()?.to_owned()))
        .collect())
}

/// The model's trained context window, per Ollama's own `/api/show`. The key is
/// architecture-prefixed (`qwen3moe.context_length`, `llama.context_length`, …),
/// so it is found by suffix rather than by a table of architectures that would
/// need an entry per new model family.
pub(crate) fn model_context_length(model: &str) -> Option<u64> {
    let body = serde_json::json!({ "model": model }).to_string();
    let v: serde_json::Value =
        serde_json::from_str(&ollama_http("POST", "/api/show", Some(&body)).ok()?).ok()?;
    v["model_info"]
        .as_object()?
        .iter()
        .find(|(k, _)| k.ends_with(".context_length"))
        .and_then(|(_, v)| v.as_u64())
        .filter(|n| *n > 0)
}

pub(crate) fn sanitize_alias(model: &str) -> String {
    model.replace(':', "-")
}

/// Reject model names that could break out of — or inject keys into — the TOML we
/// write into vibe's `config.toml`. `model` is interpolated raw inside a basic
/// TOML string (`name = "{model}"`); a `"` would close that string and a newline
/// would let an attacker append arbitrary TOML keys/tables. Control chars are
/// also illegal in TOML basic strings. We allow only the characters that appear
/// in real Ollama model refs (`<namespace>/<name>:<tag>`): ASCII alphanumerics
/// and `. _ - : /` plus `@` (digest refs). Empty names are rejected too.
///
/// The name also becomes a path: the model's Vibe home is
/// `vibe_local/<alias>` ([`app_vibe_local_dir_for`]), which
/// `prepare_local_agent` writes and "Clear conversations" deletes from. So
/// every `/`-separated part must be a real name — no empty part (a leading
/// `/` would make the home absolute, and `Path::join` would drop
/// `vibe_local` altogether), no `.` and no `..`. No Ollama ref has one; a
/// listed name that does (a remote Ollama names its own models) is refused.
pub(crate) fn validate_model_name(model: &str) -> Result<(), String> {
    let model = model.trim();
    if model.is_empty() {
        return Err("model name must not be empty".to_string());
    }
    if let Some(bad) = model
        .chars()
        .find(|c| !(c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':' | '/' | '@')))
    {
        return Err(format!("invalid character {bad:?} in model name '{model}'"));
    }
    if model.split('/').any(|part| matches!(part, "" | "." | "..")) {
        return Err(format!("invalid path part in model name '{model}'"));
    }
    Ok(())
}

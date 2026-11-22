//! The "never leaves the machine" gate for a local-model job whose input is
//! private — the mail assistant's mail (`services::mail_ai`) and an agent
//! session's last turn (`services::agent::next_prompt`).
//!
//! Two checks, both before a byte of the input is sent, in this order:
//!
//! 1. **Loopback only.** The configured Ollama host must name this machine,
//!    and that is judged here **without** consulting `ollama_allow_remote_host`:
//!    the general transport (`services::ollama_client`) may be allowed a remote
//!    host, these jobs never are.
//! 2. **The model runs here.** A loopback Ollama forwards an Ollama cloud model
//!    (`*-cloud`) to ollama.com, so the model must also be one the local Ollama
//!    lists without a remote (`ollama_client::model_is_local_at`, gap 25),
//!    failing closed on a list it cannot read. On a hosted server the model
//!    must also be one the administrator allows (`model_allowlist`).
//!
//! Each caller words the refusals itself ([`LocalRefusal`] carries only what
//! happened); the rule is one function, tested once here and again through the
//! callers' wording.

use crate::schema::Settings;
use crate::services::ollama_client as ollama;

/// Why a local-only job may not run. The callers turn it into their own words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocalRefusal {
    /// The host could not be read at all (an `https://` host, a bad port) —
    /// the general resolver's own reason, passed through.
    Endpoint(String),
    /// A host that is not this machine, refused whatever
    /// `ollama_allow_remote_host` says.
    Remote,
    /// A hosted server's administrator does not allow the model.
    NotAllowed,
    /// Nothing answered the model list: `not_running`.
    NotRunning,
    /// The listener on the port is not Ollama's (gap 50a); the reason why.
    Listener(String),
    /// An Ollama cloud model: it runs on ollama.com.
    Cloud,
    /// Not a model the local Ollama lists, or the list could not be read.
    Unlisted,
}

/// The host portion of an already-resolved `host:port` (or `[ipv6]:port`).
fn host_of_addr(addr: &str) -> &str {
    if let Some(rest) = addr.strip_prefix('[') {
        rest.split_once(']').map(|(h, _)| h).unwrap_or(rest)
    } else {
        addr.rsplit_once(':').map(|(h, _)| h).unwrap_or(addr)
    }
}

/// Resolve the configured host to a `host:port` **that is loopback**, or refuse.
///
/// It normalizes with `ollama_client::resolve_ollama_addr` (so `http://`
/// prefixes, bare ports and IPv6 are handled exactly as the general transport
/// handles them, and a `https://` host is refused for the same reason) and then
/// re-checks the literal against `host_is_loopback` — never consulting
/// `ollama_allow_remote_host`. Takes the raw host string so the whole rule is a
/// pure function.
pub fn loopback_endpoint(raw: Option<&str>) -> Result<String, LocalRefusal> {
    // `allow_remote = true` here means "don't let the general resolver reject a
    // remote host on our behalf" — the refusal is made below, in the caller's
    // words, rather than the general one that points at the very setting this
    // path ignores.
    let addr = ollama::resolve_ollama_addr(raw, true).map_err(LocalRefusal::Endpoint)?;
    if ollama::host_is_loopback(host_of_addr(&addr)) {
        Ok(addr)
    } else {
        Err(LocalRefusal::Remote)
    }
}

/// Everything settled before `model` may be sent private text: the endpoint is
/// loopback, a hosted server allows the model, and the model runs on this
/// machine. Returns the endpoint it was judged on, which every later request of
/// the job must use (never one re-read from `settings.json`).
pub fn preflight(settings: &Settings, model: &str) -> Result<String, LocalRefusal> {
    // Loopback first — before the model list, before anything reaches the network.
    let addr = loopback_endpoint(ollama::host_setting(settings).0)?;
    if crate::services::model_allowlist::check_model(model).is_err() {
        return Err(LocalRefusal::NotAllowed);
    }
    match ollama::model_is_local_at(&addr, model) {
        Ok(()) => Ok(addr),
        Err(ollama::MODEL_NOT_RUNNING) => Err(LocalRefusal::NotRunning),
        Err(ollama::LISTENER_REFUSED) => Err(LocalRefusal::Listener(listener_why(&addr))),
        Err("model_not_local") => Err(LocalRefusal::Cloud),
        Err(_) => Err(LocalRefusal::Unlisted),
    }
}

/// Why the listener on `addr` was refused, without the sentinel prefix.
fn listener_why(addr: &str) -> String {
    let why = ollama::owner_gate(addr).err().unwrap_or_default();
    why.strip_prefix(ollama::LISTENER_REFUSED)
        .map(|r| r.trim_start_matches(": ").to_string())
        .unwrap_or(why)
}

/// Whether `caps` (an `/api/show` capability list) says the model cannot write
/// text: a positive embedding-without-completion. Empty means "could not ask"
/// and is allowed, matching `model_capabilities`.
pub fn embedding_only(caps: &[String]) -> bool {
    !caps.is_empty() && caps.iter().any(|c| c == "embedding") && !caps.iter().any(|c| c == "completion")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_hosts_resolve_and_remote_ones_are_refused() {
        for host in [None, Some(""), Some("127.0.0.1:11434"), Some("http://localhost"), Some("[::1]:11434"), Some("11500")] {
            assert!(loopback_endpoint(host).is_ok(), "{host:?}");
        }
        for host in ["remote.example:11434", "http://box.local:11434"] {
            assert_eq!(loopback_endpoint(Some(host)), Err(LocalRefusal::Remote), "{host}");
        }
        assert!(matches!(loopback_endpoint(Some("https://127.0.0.1:11434")), Err(LocalRefusal::Endpoint(_))));
    }

    #[test]
    fn the_preflight_refuses_remote_hosts_before_the_list_and_cloud_models_after_it() {
        let tags = r#"{"models":[{"name":"llama3:latest"},{"name":"gpt-oss:120b-cloud","remote_host":"https://ollama.com:443"}]}"#;
        ollama::test_tags::set(Some(tags));
        let local = Settings::default();
        assert_eq!(preflight(&local, "llama3"), Ok("127.0.0.1:11434".to_string()));
        assert_eq!(preflight(&local, "gpt-oss:120b-cloud"), Err(LocalRefusal::Cloud));
        assert_eq!(preflight(&local, "mistral"), Err(LocalRefusal::Unlisted));
        let remote = Settings {
            ollama_host: Some("gpu-box.example:11434".into()),
            ollama_allow_remote_host: Some(true),
            ..Default::default()
        };
        assert_eq!(preflight(&remote, "llama3"), Err(LocalRefusal::Remote));
        ollama::test_tags::set(None);
        assert_eq!(preflight(&local, "llama3"), Err(LocalRefusal::NotRunning));
    }

    #[test]
    fn only_a_positive_embedding_only_list_is_refused() {
        let caps = |c: &[&str]| c.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(embedding_only(&caps(&["embedding"])));
        assert!(!embedding_only(&caps(&["embedding", "completion"])));
        assert!(!embedding_only(&caps(&[])));
    }
}

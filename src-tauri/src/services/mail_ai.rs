//! The local-model mail assistant's engine (Group Q, #203–#208).
//!
//! # The one invariant: the AI path never touches the internet
//!
//! Mail's IMAP/SMTP transport uses the network — unavoidable. Every feature
//! here does not: it runs only against a **loopback** Ollama, and
//! [`resolve_endpoint`] refuses a non-loopback host **even when the global
//! `ollama_allow_remote_host` is true**. That is deliberately stricter than the
//! setting the general `commands::ollama` transport honours — "classify my mail
//! on someone else's box" defeats the whole point — and it is enforced *before*
//! any socket is opened, so a remote host is a stated refusal and never a silent
//! remote call. No prompt here fetches a web page, an image or a link; the only
//! input is what the local store already holds.
//!
//! `AppHandle`-free and unit-testable: the prompt builders and the defensive
//! JSON parsers are pure functions, and the loopback rule is a pure function of
//! the configured host, so the security property is a test rather than a claim.

use std::fmt::Write as _;

use crate::commands::ollama;
use crate::schema::mail::{MailExtractedEvent, MailExtractedTask, MailPriority};
use crate::schema::Settings;

// ── Refusal reasons ─────────────────────────────────────────────────────────

/// The sentinel every 🧠 surface already branches on. Reused so an unreachable
/// server reads the same here as everywhere else.
pub const NOT_RUNNING: &str = "not_running";

/// No `mail`-role model and no default model configured.
pub const NO_MODEL: &str =
    "no local mail model is set — pick one from the brain menu's Mail role, or set a \
     default Ollama model. Nothing about your mail leaves this machine.";

/// A non-loopback host, refused regardless of `ollama_allow_remote_host`.
pub const REMOTE_REFUSED: &str =
    "the local mail assistant runs only against an Ollama on this machine and refuses a \
     remote host — even with ollama_allow_remote_host on, on purpose. Point ollama_host at \
     127.0.0.1 to use it.";

/// The reason an embedding-only model cannot answer a chat prompt.
fn embedding_only_reason(model: &str) -> String {
    format!(
        "the model '{model}' is embedding-only, so it cannot write text — load a local \
         completion model for the mail assistant."
    )
}

/// The reason a hosted server refuses a model its administrator did not allow.
fn model_not_allowed_reason(model: &str) -> String {
    format!(
        "the model '{model}' is not one the server's administrator allows — pick an \
         allowed model for the brain menu's Mail role."
    )
}

// ── Settings + model resolution ─────────────────────────────────────────────

/// The model the mail features run on: `ollama_roles["mail"] ?? ollama_model`.
/// Pure over a settings snapshot so it can be tested without a state directory.
pub fn mail_model_from(settings: &Settings) -> Option<String> {
    settings
        .ollama_roles
        .as_ref()
        .and_then(|m| m.get("mail"))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            settings
                .ollama_model
                .as_ref()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
}

/// The configured mail model, or [`NO_MODEL`].
pub fn mail_model() -> Result<String, String> {
    mail_model_from(&crate::storage::load_settings().unwrap_or_default()).ok_or_else(|| NO_MODEL.to_string())
}

// ── Loopback enforcement ────────────────────────────────────────────────────

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
/// It normalizes with `commands::ollama::resolve_ollama_addr` (so `http://`
/// prefixes, bare ports and IPv6 are handled exactly as the general transport
/// handles them, and a `https://` host is refused for the same reason) and then
/// re-checks the literal against `host_is_loopback` — never consulting
/// `ollama_allow_remote_host`, which is what makes this stricter than the
/// setting. Takes the raw host string so the whole rule is a pure function.
pub fn resolve_endpoint(raw: Option<&str>) -> Result<String, String> {
    // `allow_remote = true` here means "don't let the general resolver reject a
    // remote host on our behalf" — we want to make that refusal ourselves, with
    // the mail-specific reason, rather than emit the general one that points at
    // the very setting this path ignores.
    let addr = ollama::resolve_ollama_addr(raw, true)?;
    if ollama::host_is_loopback(host_of_addr(&addr)) {
        Ok(addr)
    } else {
        Err(REMOTE_REFUSED.to_string())
    }
}

// ── The chat wrapper ────────────────────────────────────────────────────────

/// A bounded, low-temperature chat request. Small by construction — these are
/// extraction/summary jobs, not conversations.
#[derive(Debug, Clone, Copy)]
pub struct ChatOptions {
    pub num_predict: i64,
    pub temperature: f64,
}

impl ChatOptions {
    /// Sensible ceilings for a one-shot mail job.
    pub fn bounded(num_predict: i64) -> Self {
        ChatOptions {
            num_predict: num_predict.clamp(16, 1024),
            temperature: 0.1,
        }
    }
}

/// Run a `system` + `user` prompt against the loopback mail model and return the
/// assistant's text.
///
/// Order matters and is load-bearing: **loopback is enforced before any socket
/// is opened**, so a remote host never sees a byte. Only then are capabilities
/// probed (an embedding-only model is refused; empty/absent capabilities read as
/// unknown → allow, matching `model_capabilities`), and only then is the request
/// sent. An unreachable server surfaces as [`NOT_RUNNING`].
pub fn chat(system: &str, user: &str, opts: ChatOptions) -> Result<String, String> {
    let settings = crate::storage::load_settings().unwrap_or_default();
    let model = mail_model_from(&settings).ok_or_else(|| NO_MODEL.to_string())?;

    // Loopback first — before capabilities, before the request, before anything
    // reaches the network.
    resolve_endpoint(ollama::host_setting(&settings).0)?;
    // On a hosted server, only a model the admin allows may be loaded on the
    // one shared Ollama — the classifier an inbox sync runs included
    // (`model_allowlist`, final review A1). Nothing off a server.
    if crate::services::model_allowlist::check_model(&model).is_err() {
        return Err(model_not_allowed_reason(&model));
    }

    // Empty capabilities = "could not ask" = unknown → allow. Only a *positive*
    // embedding-without-completion is a refusal.
    let caps = ollama::capabilities_of(&model);
    if !caps.is_empty()
        && caps.iter().any(|c| c == "embedding")
        && !caps.iter().any(|c| c == "completion")
    {
        return Err(embedding_only_reason(&model));
    }

    let body = serde_json::json!({
        "model": model,
        "stream": false,
        "options": {
            "temperature": opts.temperature,
            "num_predict": opts.num_predict,
        },
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user },
        ],
    })
    .to_string();

    // `ollama_http` re-resolves the address with the user's own settings, but a
    // loopback host resolves identically whatever `ollama_allow_remote_host`
    // says — and we have already refused every non-loopback host above — so this
    // can only ever dial the loopback endpoint we just checked. An unreachable
    // server comes back as `not_running` from here unchanged.
    let raw = ollama::ollama_http("POST", "/api/chat", Some(&body))?;
    let v: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("the local model returned malformed JSON: {e}"))?;
    let content = v["message"]["content"]
        .as_str()
        .unwrap_or_default()
        .trim()
        .to_string();
    if content.is_empty() {
        return Err("the local model returned an empty response.".to_string());
    }
    Ok(content)
}

// ── Prompt builders (pure) ──────────────────────────────────────────────────

pub const SUMMARIZE_SYSTEM: &str =
    "You summarize one email in at most five short bullet points. Output only the bullets, \
     one per line, each beginning with '- '. No preamble, no heading, no sign-off. This \
     runs entirely on the reader's machine.";

pub fn summarize_user(subject: &str, from: &str, body: &str) -> String {
    format!("Subject: {subject}\nFrom: {from}\n\n{body}")
}

pub const FORMALIZE_SYSTEM: &str =
    "You turn rough notes into a polished, professional email reply. Output only the reply \
     body text — no subject line, no email headers, no quoted original message. Keep it \
     concise and courteous.";

/// The formalize prompt. `original` is the message being replied to (context,
/// never quoted back), `tone` an optional style hint, `sender_name` the account
/// name to sign off with.
pub fn formalize_user(
    notes: &str,
    original: Option<&str>,
    tone: Option<&str>,
    sender_name: Option<&str>,
) -> String {
    let mut out = String::new();
    if let Some(tone) = tone.map(str::trim).filter(|t| !t.is_empty()) {
        let _ = writeln!(out, "Desired tone: {tone}");
    }
    if let Some(name) = sender_name.map(str::trim).filter(|n| !n.is_empty()) {
        let _ = writeln!(out, "Sign the reply as: {name}");
    }
    if let Some(original) = original.map(str::trim).filter(|o| !o.is_empty()) {
        let _ = writeln!(out, "\nThe message being replied to:\n{original}");
    }
    let _ = writeln!(out, "\nMy rough notes for the reply:\n{}", notes.trim());
    out
}

pub const EVENT_SYSTEM: &str =
    "You extract a single calendar event from an email, or report that there is none. \
     Respond with exactly ONE JSON object and nothing else, of the form \
     {\"title\":string,\"start\":\"YYYY-MM-DDTHH:MM\",\"end\":string|null,\"all_day\":boolean,\
     \"location\":string|null,\"confidence\":number}. `start`/`end` are local wall-clock \
     times; use \"YYYY-MM-DD\" for an all-day event. Resolve relative dates (\"next \
     Tuesday\", \"tomorrow 3pm\") using the two anchor dates given, never today's real \
     clock. `confidence` is 0..1; if there is no concrete event, set it to 0.";

/// The event prompt, **anchored on the message's own `Date` and today** so
/// relative phrasing resolves and the model is never trusted as the clock.
pub fn event_user(
    subject: &str,
    from: &str,
    body: &str,
    message_date: &str,
    today: &str,
) -> String {
    format!(
        "The email was sent on: {message_date}\nToday's date is: {today}\n\n\
         Subject: {subject}\nFrom: {from}\n\n{body}"
    )
}

pub const TASK_SYSTEM: &str =
    "You extract a single to-do task from an email, or report that there is none. Respond \
     with exactly ONE JSON object and nothing else, of the form \
     {\"title\":string,\"due\":\"YYYY-MM-DD\"|null,\"priority\":\"high\"|\"normal\"|\"low\"|null}. \
     Resolve a relative due date using the two anchor dates given. If there is no actionable \
     task, set title to an empty string.";

/// The task prompt, anchored the same way as [`event_user`].
pub fn task_user(subject: &str, from: &str, body: &str, message_date: &str, today: &str) -> String {
    format!(
        "The email was sent on: {message_date}\nToday's date is: {today}\n\n\
         Subject: {subject}\nFrom: {from}\n\n{body}"
    )
}

pub const CLASSIFY_SYSTEM: &str =
    "You triage one incoming email into a priority. Respond with exactly ONE JSON object: \
     {\"priority\":\"urgent\"|\"important\"|\"none\",\"reason\":string}. \"urgent\" means it \
     needs action very soon; \"important\" means it matters but is not time-critical; \
     \"none\" means routine. Judge only from the subject, sender and short preview given — \
     you do not have the full body. Keep the reason to one short sentence.";

/// The classify prompt. **Subject, sender and preview only** — never a body
/// download (#205).
pub fn classify_user(subject: &str, from: &str, preview: &str) -> String {
    format!("Subject: {subject}\nFrom: {from}\nPreview: {preview}")
}

// ── Defensive JSON parsing (pure) ───────────────────────────────────────────

/// Extract the first balanced `{ … }` object from arbitrary model text.
///
/// A local model wraps JSON in prose, code fences or a "Sure, here you go" as
/// often as not, so nothing here trusts the whole response to *be* JSON. It
/// walks to the first `{`, tracks brace depth honouring string literals and
/// their escapes, and parses the balanced span — returning `None` rather than
/// erroring, because an unparseable extraction is "nothing to create", not a
/// failure to shout about.
pub fn extract_json_object(text: &str) -> Option<serde_json::Value> {
    let start = text.find('{')?;
    let mut depth = 0i32;
    let mut in_str = false;
    let mut escaped = false;
    for (i, b) in text[start..].bytes().enumerate() {
        if in_str {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_str = false;
            }
            continue;
        }
        match b {
            b'"' => in_str = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    // `{`, `}` and every intervening brace are ASCII, so
                    // `start + i + 1` is a char boundary.
                    return serde_json::from_str(&text[start..start + i + 1]).ok();
                }
            }
            _ => {}
        }
    }
    None
}

/// A non-empty, trimmed string field, or `None`.
fn str_field(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|f| f.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Loosely "does this look like an ISO date or datetime" — a digit and a dash,
/// enough to reject prose the model may have put where a date belongs without
/// pretending to validate a calendar.
fn looks_like_date(s: &str) -> bool {
    s.contains('-') && s.chars().any(|c| c.is_ascii_digit()) && s.len() >= 8
}

/// The confidence below which an extracted event is discarded.
pub const EVENT_CONFIDENCE_FLOOR: f64 = 0.4;

/// Parse an event out of model text, defensively. `None` for anything missing a
/// title or a plausible start, or below [`EVENT_CONFIDENCE_FLOOR`].
pub fn parse_event(text: &str) -> Option<MailExtractedEvent> {
    let v = extract_json_object(text)?;
    let title = str_field(&v, "title")?;
    let start = str_field(&v, "start").filter(|s| looks_like_date(s))?;
    // A model that omits confidence still gets the benefit of the doubt; one
    // that states a low number is dropped.
    let confidence = v.get("confidence").and_then(|c| c.as_f64()).unwrap_or(0.5);
    let confidence = confidence.clamp(0.0, 1.0);
    if confidence < EVENT_CONFIDENCE_FLOOR {
        return None;
    }
    Some(MailExtractedEvent {
        title,
        start,
        end: str_field(&v, "end").filter(|s| looks_like_date(s)),
        all_day: v.get("all_day").and_then(|b| b.as_bool()).unwrap_or(false),
        location: str_field(&v, "location"),
        confidence,
    })
}

/// Parse a task out of model text, defensively. `None` when there is no title.
pub fn parse_task(text: &str) -> Option<MailExtractedTask> {
    let v = extract_json_object(text)?;
    let title = str_field(&v, "title")?;
    Some(MailExtractedTask {
        title,
        due: str_field(&v, "due").filter(|s| looks_like_date(s)),
        priority: str_field(&v, "priority").and_then(normalize_priority),
    })
}

/// Map a model's priority word onto the board's vocabulary (`high`/`normal`/
/// `low`), or `None` for anything routine/unrecognized.
fn normalize_priority(s: String) -> Option<String> {
    match s.trim().to_ascii_lowercase().as_str() {
        "high" | "urgent" | "important" => Some("high".to_string()),
        "normal" | "medium" | "med" => Some("normal".to_string()),
        "low" => Some("low".to_string()),
        _ => None,
    }
}

/// Parse a classification verdict. `Some((mark, reason))` only for a real mark;
/// `"none"` / unrecognized / missing → `None`, meaning "leave it unmarked".
pub fn parse_classification(text: &str) -> Option<(MailPriority, String)> {
    let v = extract_json_object(text)?;
    let mark = match v
        .get("priority")
        .and_then(|p| p.as_str())
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "urgent" => MailPriority::Urgent,
        "important" => MailPriority::Important,
        _ => return None,
    };
    let reason = v
        .get("reason")
        .and_then(|r| r.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    Some((mark, reason))
}

// ── Live-model helpers (call `chat`) ────────────────────────────────────────

/// Classify one message from its subject/sender/preview. `Ok(None)` = leave it
/// unmarked. Used by the sync hook and by `mail_ai_classify_apply`.
pub fn classify(
    subject: &str,
    from: &str,
    preview: &str,
) -> Result<Option<(MailPriority, String)>, String> {
    let out = chat(
        CLASSIFY_SYSTEM,
        &classify_user(subject, from, preview),
        ChatOptions::bounded(128),
    )?;
    Ok(parse_classification(&out))
}

// ── Today, without a date library ───────────────────────────────────────────

/// Today's date as `YYYY-MM-DD` (UTC). The event/task prompts anchor on this and
/// on the message's own `Date`, so a UTC day boundary is close enough — the
/// model is given both anchors and is never trusted as the clock anyway.
pub fn today_iso() -> String {
    let secs = crate::clock::now_secs() as i64;
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    format!("{y:04}-{m:02}-{d:02}")
}

/// Civil date from days since the Unix epoch (Howard Hinnant's algorithm), the
/// same one `commands::screenshot` carries — duplicated rather than shared to
/// keep this module `commands`-light and independently testable.
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    // ── Loopback enforcement — the load-bearing security property ───────────

    #[test]
    fn loopback_hosts_are_accepted() {
        for host in [
            None,
            Some(""),
            Some("127.0.0.1:11434"),
            Some("http://127.0.0.1:11434"),
            Some("localhost:11500"),
            Some("http://localhost"),
            Some("[::1]:11434"),
            Some("11500"), // a bare port is loopback:port
        ] {
            assert!(
                resolve_endpoint(host).is_ok(),
                "loopback host {host:?} should resolve"
            );
        }
    }

    #[test]
    fn a_non_loopback_host_is_refused() {
        for host in [
            "remote.example:11434",
            "http://not-loopback.example:11434",
            "ollama.example.com:11434",
            "http://box.local:11434",
        ] {
            let err = resolve_endpoint(Some(host)).expect_err("must refuse a remote host");
            assert!(err.contains("this machine"), "reason: {err}");
        }
    }

    /// The whole point of the module: the refusal does not consult
    /// `ollama_allow_remote_host`, so turning that on cannot loosen it. The
    /// resolver takes no allow-remote parameter at all, and the endpoint the
    /// chat path uses is derived only from the host — proven here by refusing a
    /// remote host on a settings object that has the remote opt-in switched on.
    #[test]
    fn a_remote_host_is_refused_even_with_allow_remote_true() {
        let settings = Settings {
            ollama_host: Some("http://not-loopback.example:11434".to_string()),
            ollama_allow_remote_host: Some(true),
            ..Default::default()
        };
        let err = resolve_endpoint(settings.ollama_host.as_deref())
            .expect_err("loopback rule must ignore the remote opt-in");
        assert!(err.contains("even with ollama_allow_remote_host"), "{err}");
    }

    #[test]
    fn an_https_host_is_still_refused_here_too() {
        assert!(resolve_endpoint(Some("https://127.0.0.1:11434")).is_err());
    }

    // ── Model resolution ────────────────────────────────────────────────────

    #[test]
    fn mail_model_prefers_the_role_then_the_default() {
        let mut roles = HashMap::new();
        roles.insert("mail".to_string(), "llama3.2".to_string());
        let s = Settings {
            ollama_roles: Some(roles),
            ollama_model: Some("qwen2.5".to_string()),
            ..Default::default()
        };
        assert_eq!(mail_model_from(&s).as_deref(), Some("llama3.2"));

        let s = Settings {
            ollama_model: Some("qwen2.5".to_string()),
            ..Default::default()
        };
        assert_eq!(mail_model_from(&s).as_deref(), Some("qwen2.5"));

        // A blank role falls through to the default rather than resolving empty.
        let mut roles = HashMap::new();
        roles.insert("mail".to_string(), "   ".to_string());
        let s = Settings {
            ollama_roles: Some(roles),
            ollama_model: Some("qwen2.5".to_string()),
            ..Default::default()
        };
        assert_eq!(mail_model_from(&s).as_deref(), Some("qwen2.5"));

        assert!(mail_model_from(&Settings::default()).is_none());
    }

    // ── Prompt builders anchor on both dates ────────────────────────────────

    #[test]
    fn the_event_prompt_is_anchored_on_the_message_date_and_today() {
        let user = event_user(
            "Sync",
            "boss@example.com",
            "Let's meet next Tuesday at 3pm.",
            "2026-07-30T09:00:00Z",
            "2026-07-31",
        );
        assert!(
            user.contains("2026-07-30T09:00:00Z"),
            "message date missing"
        );
        assert!(user.contains("2026-07-31"), "today missing");
        assert!(user.contains("next Tuesday"), "body missing");
    }

    #[test]
    fn the_task_prompt_is_anchored_on_both_dates() {
        let user = task_user(
            "Report",
            "pm@example.com",
            "Please send the numbers by Friday.",
            "2026-07-30",
            "2026-07-31",
        );
        assert!(user.contains("2026-07-30"));
        assert!(user.contains("2026-07-31"));
    }

    #[test]
    fn the_classify_prompt_carries_only_header_and_preview() {
        let u = classify_user("Invoice overdue", "billing@acme.example", "Your invoice…");
        assert!(u.contains("Invoice overdue"));
        assert!(u.contains("billing@acme.example"));
        assert!(u.contains("Preview: Your invoice…"));
    }

    #[test]
    fn the_formalize_prompt_folds_in_the_optional_context() {
        let u = formalize_user(
            "yes, thursday works, send the deck",
            Some("Can we meet Thursday?"),
            Some("warm"),
            Some("Alex"),
        );
        assert!(u.contains("warm"));
        assert!(u.contains("Sign the reply as: Alex"));
        assert!(u.contains("Can we meet Thursday?"));
        assert!(u.contains("send the deck"));

        // With no context it is just the notes.
        let bare = formalize_user("call them back", None, None, None);
        assert!(bare.contains("call them back"));
        assert!(!bare.contains("Desired tone"));
        assert!(!bare.contains("Sign the reply"));
    }

    // ── JSON extraction / parsers ───────────────────────────────────────────

    #[test]
    fn json_is_extracted_from_prose_and_fences() {
        let v =
            extract_json_object("Sure! ```json\n{\"a\": 1}\n``` hope that helps").expect("object");
        assert_eq!(v["a"], 1);
        // A brace inside a string must not close the object early.
        let v = extract_json_object("{\"title\": \"a } b\", \"n\": 2}").expect("nested brace");
        assert_eq!(v["title"], "a } b");
        assert_eq!(v["n"], 2);
        assert!(extract_json_object("no json here").is_none());
    }

    #[test]
    fn an_event_parses_and_low_confidence_is_dropped() {
        let ev = parse_event(
            "{\"title\":\"Standup\",\"start\":\"2026-08-04T15:00\",\"end\":null,\
             \"all_day\":false,\"location\":\"Room 2\",\"confidence\":0.9}",
        )
        .expect("event");
        assert_eq!(ev.title, "Standup");
        assert_eq!(ev.start, "2026-08-04T15:00");
        assert_eq!(ev.location.as_deref(), Some("Room 2"));
        assert!(ev.end.is_none());
        assert!(!ev.all_day);

        // Below the floor → nothing to create.
        assert!(parse_event(
            "{\"title\":\"Maybe\",\"start\":\"2026-08-04T15:00\",\"confidence\":0.1}"
        )
        .is_none());
        // Missing a title → nothing.
        assert!(parse_event("{\"start\":\"2026-08-04T15:00\",\"confidence\":0.9}").is_none());
        // A start that is not date-shaped → nothing.
        assert!(
            parse_event("{\"title\":\"X\",\"start\":\"sometime\",\"confidence\":0.9}").is_none()
        );
        // An all-day date-only start is fine.
        let allday = parse_event(
            "{\"title\":\"Holiday\",\"start\":\"2026-12-25\",\"all_day\":true,\"confidence\":0.8}",
        )
        .expect("all-day");
        assert!(allday.all_day);
    }

    #[test]
    fn a_task_parses_and_normalizes_priority() {
        let t = parse_task(
            "{\"title\":\"Send report\",\"due\":\"2026-08-07\",\"priority\":\"urgent\"}",
        )
        .expect("task");
        assert_eq!(t.title, "Send report");
        assert_eq!(t.due.as_deref(), Some("2026-08-07"));
        assert_eq!(t.priority.as_deref(), Some("high"));

        // An unknown priority becomes None rather than a made-up bucket.
        let t = parse_task("{\"title\":\"X\",\"priority\":\"whenever\"}").expect("task");
        assert!(t.priority.is_none());
        // No title → nothing to create.
        assert!(parse_task("{\"due\":\"2026-08-07\"}").is_none());
    }

    #[test]
    fn a_classification_maps_marks_and_ignores_none() {
        assert_eq!(
            parse_classification("{\"priority\":\"urgent\",\"reason\":\"deadline today\"}"),
            Some((MailPriority::Urgent, "deadline today".to_string()))
        );
        assert_eq!(
            parse_classification("{\"priority\":\"IMPORTANT\",\"reason\":\"\"}"),
            Some((MailPriority::Important, String::new()))
        );
        assert!(parse_classification("{\"priority\":\"none\",\"reason\":\"routine\"}").is_none());
        assert!(parse_classification("{\"priority\":\"weird\"}").is_none());
        assert!(parse_classification("not json").is_none());
    }

    #[test]
    fn today_is_a_plausible_iso_date() {
        let t = today_iso();
        assert_eq!(t.len(), 10, "{t}");
        assert_eq!(&t[4..5], "-");
        assert_eq!(&t[7..8], "-");
        // Epoch-day arithmetic sanity: 2021-01-01 was day 18628.
        assert_eq!(civil_from_days(18628), (2021, 1, 1));
    }
}

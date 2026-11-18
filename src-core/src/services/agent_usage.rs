//! Account usage without opening a tab: Claude print mode and Codex account RPC.
//!
//! `claude -p "/usage" --output-format json` prints what the `/usage` slash
//! command draws in-session — the 5-hour window, the weekly window, the
//! per-model weekly lines — into the JSON envelope's `result` field. The run is
//! client-side: it comes back reporting `num_turns: 0` and zero tokens, so
//! nothing here spends quota in order to ask how much quota is left. That is
//! what makes it safe to spawn because a phone asked, rather than only on a
//! schedule.
//!
//! Only recipes verified against an installed CLI are listed. An agent without
//! one is reported as *unsupported*, never guessed at — the same refusal
//! `WARMUPS` makes in `commands::agents`, and for the same reason: a wrong flag
//! either opens an interactive TUI on a null stdin that then sits there, or
//! runs nothing while the caller believes it ran.
//!
//! The panel's text is passed on as the CLI printed it (ANSI removed, bounded)
//! and parsed by the reader — `mobile-web/src/terminal/usageReport.ts` for the
//! phone. The format is an implementation detail of somebody else's CLI, so a
//! change to it must degrade to a readable block, not to an empty card.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// How long one usage run may take before it is killed. A print-mode `/usage`
/// answers in well under a second once the CLI is warm; the ceiling is here for
/// the cold start and for a CLI that stops on a first-run trust prompt, and it
/// sits below the bridge's own response deadline so the caller sees a stated
/// failure rather than a timed-out socket.
pub const USAGE_TIMEOUT: Duration = Duration::from_secs(15);

/// Longest panel text passed on. The real one is a few hundred bytes; the bound
/// exists so a CLI that decides to print its whole log cannot push a megabyte
/// through the bridge and onto a phone.
pub const MAX_USAGE_TEXT: usize = 8 * 1024;

/// How long a successful read is reused. Short enough that a reader watching a
/// window fill sees it move, long enough that reopening the sheet — or two
/// phones asking at once — does not spawn a CLI each time.
pub const CACHE_TTL: Duration = Duration::from_secs(60);

/// The shortest gap between two *forced* runs. A refresh means "ask the CLI
/// again", but a reader tapping it must not get one process per tap — a phone
/// on a flaky link retries, and the sheet's button is one thumb away from being
/// held down.
pub const REFRESH_FLOOR: Duration = Duration::from_secs(10);

/// Verified non-interactive usage entry points. Codex's app-server needs a
/// JSON-RPC handshake and `account/rateLimits/read`, never a model turn.
const RECIPES: &[(&str, &[&str])] = &[
    ("claude", &["-p", "/usage", "--output-format", "json"]),
    ("codex", &["app-server", "--listen", "stdio://"]),
];

/// The one-shot usage argv for `agent_id`, or `None` when that CLI has no
/// readable usage panel.
pub fn usage_argv(agent_id: &str) -> Option<Vec<String>> {
    RECIPES
        .iter()
        .find(|(id, _)| *id == agent_id)
        .map(|(_, args)| args.iter().map(|s| (*s).to_string()).collect())
}

/// True when this agent has a usage recipe at all — what the caller reports as
/// `usage_supported`, so the reader is told "this CLI cannot say" instead of
/// being shown an empty panel.
pub fn is_supported(agent_id: &str) -> bool {
    RECIPES.iter().any(|(id, _)| *id == agent_id)
}

/// Drop the escape sequences a CLI writes even into a pipe. Print mode is
/// mostly plain, but `--output-format json` is not a promise about the text
/// *inside* the envelope, and one stray colour reset would reach the phone as
/// literal `[0m` in the middle of a percentage.
///
/// Deliberately a small recognizer, not a terminal emulator: CSI (`ESC [ … final`)
/// and the string-terminated families (OSC/DCS/APC/PM/SOS) are dropped whole,
/// any other `ESC x` loses both bytes, and everything else — including the box
/// drawing the panel is made of — is kept.
pub fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' {
            if ch != '\r' {
                out.push(ch);
            }
            continue;
        }
        match chars.next() {
            // CSI: parameter and intermediate bytes, then one final byte.
            Some('[') => {
                for next in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&next) {
                        break;
                    }
                }
            }
            // OSC and friends run to BEL or to a string terminator (ESC \).
            Some(']' | 'P' | 'X' | '^' | '_') => {
                let mut escaped = false;
                for next in chars.by_ref() {
                    if next == '\u{7}' {
                        break;
                    }
                    if escaped {
                        if next == '\\' {
                            break;
                        }
                        escaped = false;
                    }
                    if next == '\u{1b}' {
                        escaped = true;
                    }
                }
            }
            // Any other two-byte escape: both bytes go.
            _ => {}
        }
    }
    out
}

/// Trim to `MAX_USAGE_TEXT`, on a character boundary, marking the cut so the
/// reader is never shown a silently truncated figure.
fn bounded(text: String) -> String {
    if text.len() <= MAX_USAGE_TEXT {
        return text;
    }
    let mut cut = MAX_USAGE_TEXT;
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}\n…", &text[..cut])
}

/// The panel text out of one finished run, or the reason there is none.
///
/// Claude's print mode wraps its answer in a JSON envelope whose `result` holds
/// the panel; an envelope flagged `is_error` carries the CLI's own complaint
/// there instead, and that complaint is the most useful thing to show. A
/// non-JSON stdout is passed through as-is, because a CLI that drops the
/// envelope has still printed something a reader can read.
pub fn report_text(stdout: &str, stderr: &str, code: Option<i32>) -> Result<String, String> {
    let envelope = serde_json::from_str::<serde_json::Value>(stdout.trim()).ok();
    let result = envelope
        .as_ref()
        .and_then(|value| value.get("result"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty());
    let failed = envelope
        .as_ref()
        .and_then(|value| value.get("is_error"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    if let Some(text) = result {
        let text = bounded(strip_ansi(text).trim().to_string());
        return if failed { Err(text) } else { Ok(text) };
    }
    let plain = bounded(strip_ansi(stdout).trim().to_string());
    if !plain.is_empty() && code == Some(0) && envelope.is_none() {
        return Ok(plain);
    }
    let complaint = bounded(strip_ansi(stderr).trim().to_string());
    Err(if !complaint.is_empty() {
        complaint
    } else if !plain.is_empty() {
        plain
    } else {
        match code {
            Some(status) => format!("the CLI exited with status {status} and printed nothing"),
            None => "the CLI was stopped before it answered".to_string(),
        }
    })
}

// One probe at a time: callers waiting behind a read recheck the shared cache.
pub async fn read_lock(agent_id: &str) -> tokio::sync::MutexGuard<'static, ()> {
    static CODEX: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    static OTHER: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    if agent_id == "codex" { CODEX.lock().await } else { OTHER.lock().await }
}

fn failures() -> &'static Mutex<HashMap<String, (Instant, String)>> {
    static FAILURES: OnceLock<Mutex<HashMap<String, (Instant, String)>>> = OnceLock::new();
    FAILURES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Failed reads are briefly shared too, preventing one spawn per waiting tab.
pub fn recent_failure(agent_id: &str) -> Option<String> {
    let failures = failures().lock().ok()?;
    let (at, error) = failures.get(agent_id)?;
    (at.elapsed() < REFRESH_FLOOR).then(|| error.clone())
}

pub fn remember_failure(agent_id: &str, error: &str) {
    if let Ok(mut failures) = failures().lock() {
        failures.insert(agent_id.to_string(), (Instant::now(), error.to_string()));
    }
}

type Cache = Mutex<HashMap<String, (Instant, u64, String)>>;

/// When the cached reading was obtained, in Unix milliseconds (not cache-hit time).
pub fn read_at(agent_id: &str) -> Option<u64> {
    cache().lock().ok()?.get(agent_id).map(|(_, at, _)| *at)
}

/// Keep a failed refresh's last successful reading, without renewing its age.
pub fn last_reading(agent_id: &str) -> Option<String> {
    cache().lock().ok()?.get(agent_id).map(|(_, _, raw)| raw.clone())
}

fn cache() -> &'static Cache {
    static CACHE: OnceLock<Cache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The last panel read for this agent, if it is younger than `max_age`.
pub fn cached_within(agent_id: &str, max_age: Duration) -> Option<String> {
    let cache = cache().lock().ok()?;
    let (at, _, text) = cache.get(agent_id)?;
    (at.elapsed() < max_age).then(|| text.clone())
}

/// The last panel read for this agent, if it is still inside `CACHE_TTL`.
pub fn cached(agent_id: &str) -> Option<String> {
    cached_within(agent_id, CACHE_TTL)
}

/// Keep a successful read for the next asker.
pub fn remember(agent_id: &str, text: &str) {
    if let Ok(mut failures) = failures().lock() { failures.remove(agent_id); }
    if let Ok(mut cache) = cache().lock() {
        let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default().as_millis() as u64;
        cache.insert(agent_id.to_string(), (Instant::now(), at, text.to_string()));
    }
}

/// Drop a cached read — what an explicit refresh does, so the button means
/// "ask the CLI again" rather than "show me the same minute-old answer".
pub fn forget(agent_id: &str) {
    if let Ok(mut cache) = cache().lock() {
        cache.remove(agent_id);
    }
}

/// Read a bounded JSON-RPC reply, ignoring notifications but refusing errors.
async fn codex_reply<R: tokio::io::AsyncBufRead + Unpin>(reader: &mut R, id: u64) -> Result<serde_json::Value, String> {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt};
    // Bound both individual messages and the total notification stream.
    for _ in 0..64 {
        let mut line = Vec::new();
        let n = (&mut *reader).take(64 * 1024 + 1).read_until(b'\n', &mut line).await
            .map_err(|_| "cannot read Codex account limits".to_string())?;
        if n == 0 || n > 64 * 1024 {
            return Err("Codex account limits reply is missing or too large".into());
        }
        let value: serde_json::Value = serde_json::from_slice(&line)
            .map_err(|_| "invalid Codex account limits reply".to_string())?;
        if value.get("id").and_then(serde_json::Value::as_u64) != Some(id) { continue; }
        if value.get("error").is_some() {
            // Do not forward server diagnostics: they may contain credentials or paths.
            return Err("Codex could not read account limits; check its ChatGPT sign-in".into());
        }
        return value.get("result").cloned().ok_or_else(|| "missing Codex result".into());
    }
    Err("too many Codex notifications before account limits".into())
}

async fn codex_exchange<R, W>(reader: &mut R, writer: &mut W) -> Result<String, String>
where R: tokio::io::AsyncBufRead + Unpin, W: tokio::io::AsyncWrite + Unpin {
    use tokio::io::AsyncWriteExt;
    let initialize = serde_json::json!({"id": 0, "method": "initialize", "params": {
        "clientInfo": {"name": crate::brand::SLUG, "version": env!("CARGO_PKG_VERSION")}
    }});
    writer.write_all(format!("{initialize}\n").as_bytes()).await.map_err(|_| "cannot initialize Codex".to_string())?;
    writer.flush().await.map_err(|_| "cannot initialize Codex".to_string())?;
    codex_reply(reader, 0).await?;
    writer.write_all(b"{\"method\":\"initialized\"}\n{\"id\":1,\"method\":\"account/rateLimits/read\"}\n")
        .await.map_err(|_| "cannot request Codex account limits".to_string())?;
    writer.flush().await.map_err(|_| "cannot request Codex account limits".to_string())?;
    codex_panel(&codex_reply(reader, 1).await?)
}

/// Normalize only the account-wide Codex bucket to the existing usage panel
/// contract. Missing windows remain missing; other model buckets never substitute.
pub fn codex_panel(result: &serde_json::Value) -> Result<String, String> {
    let limits = result.pointer("/rateLimitsByLimitId/codex")
        .or_else(|| result.get("rateLimits").filter(|v| {
            v.get("limitId").and_then(serde_json::Value::as_str).is_none_or(|id| id == "codex")
        })).ok_or_else(|| "Codex returned no account limits".to_string())?;
    let mut lines = Vec::new();
    for (key, fallback_session) in [("primary", true), ("secondary", false)] {
        let Some(window) = limits.get(key) else { continue };
        let Some(used) = window.get("usedPercent").and_then(serde_json::Value::as_f64).filter(|v| v.is_finite()) else { continue };
        let session = window.get("windowDurationMins").and_then(serde_json::Value::as_u64)
            .map_or(fallback_session, |minutes| minutes <= 24 * 60);
        let label = if session { "Current session" } else { "Current week" };
        let reset = window.get("resetsAt").and_then(serde_json::Value::as_i64)
            .and_then(|at| chrono::DateTime::from_timestamp(at, 0))
            .map(|at| format!(" · resets {} (UTC)", at.format("%b %-d, %Y, %-I:%M%P")))
            .unwrap_or_default();
        lines.push(format!("{label}: {}% used{reset}", used.clamp(0.0, 100.0)));
    }
    if lines.is_empty() { Err("Codex returned no account limit windows".into()) } else { Ok(lines.join("\n")) }
}

/// Start only the account RPC surface in the prepared probe home. Bound the
/// exchange, then kill and reap the server on success, failure and timeout.
pub async fn read_codex_limits(cmd: &mut tokio::process::Command) -> Result<String, String> {
    let mut child = cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null())
        .kill_on_drop(true).spawn().map_err(|_| "cannot start Codex account limits reader".to_string())?;
    let result = tokio::time::timeout(USAGE_TIMEOUT, async {
        let mut writer = child.stdin.take().ok_or("missing Codex stdin")?;
        let mut reader = tokio::io::BufReader::new(child.stdout.take().ok_or("missing Codex stdout")?);
        codex_exchange(&mut reader, &mut writer).await
    }).await.unwrap_or_else(|_| Err("Codex account limits request timed out".into()));
    let _ = child.kill().await;
    let _ = child.wait().await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_limits_keep_partial_windows_and_select_the_account_bucket() {
        let result = serde_json::json!({
            "rateLimits": {"limitId": "other", "primary": {"usedPercent": 99}},
            "rateLimitsByLimitId": {"codex": {
                "primary": {"usedPercent": 12.5, "windowDurationMins": 300, "resetsAt": 1795003200i64},
                "secondary": null
            }}
        });
        assert_eq!(codex_panel(&result).unwrap(), "Current session: 12.5% used · resets Nov 18, 2026, 12:00pm (UTC)");
        assert!(codex_panel(&serde_json::json!({"rateLimits": {"primary": null, "secondary": null}})).is_err());
        assert!(codex_panel(&serde_json::json!({"rateLimits": {"limitId": "other", "primary": {"usedPercent": 99}}})).is_err());
        let week = serde_json::json!({"rateLimits": {"primary": {"usedPercent": 104, "windowDurationMins": 10080}}});
        assert_eq!(codex_panel(&week).unwrap(), "Current week: 100% used");
    }

    #[tokio::test]
    async fn codex_handshake_reads_limits_without_starting_a_thread_or_turn() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let (client, server) = tokio::io::duplex(8192);
        let (client_read, mut client_write) = tokio::io::split(client);
        let (server_read, mut server_write) = tokio::io::split(server);
        let fake_server = async move {
            let mut reader = BufReader::new(server_read);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let request: serde_json::Value = serde_json::from_str(&line).unwrap();
            assert_eq!(request["method"], "initialize");
            server_write.write_all(b"{\"id\":0,\"result\":{}}\n").await.unwrap();
            line.clear();
            reader.read_line(&mut line).await.unwrap();
            assert_eq!(serde_json::from_str::<serde_json::Value>(&line).unwrap()["method"], "initialized");
            line.clear();
            reader.read_line(&mut line).await.unwrap();
            assert_eq!(serde_json::from_str::<serde_json::Value>(&line).unwrap(), serde_json::json!({"id":1,"method":"account/rateLimits/read"}));
            server_write.write_all(b"{\"method\":\"account/updated\",\"params\":{}}\n{\"id\":1,\"result\":{\"rateLimits\":{\"primary\":{\"usedPercent\":25},\"secondary\":{\"usedPercent\":80}}}}\n").await.unwrap();
        };
        let read = async { codex_exchange(&mut BufReader::new(client_read), &mut client_write).await };
        let (result, ()) = tokio::join!(read, fake_server);
        assert_eq!(result.unwrap(), "Current session: 25% used\nCurrent week: 80% used");
    }

    #[tokio::test]
    async fn codex_errors_and_unbounded_output_never_become_a_usage_reading() {
        for body in [
            "{\"id\":1,\"error\":{\"message\":\"private details\"}}\n".to_string(),
            "x".repeat(64 * 1024 + 1),
            "not JSON\n".to_string(),
            String::new(),
        ] {
            let error = codex_reply(&mut body.as_bytes(), 1).await.unwrap_err();
            assert!(!error.contains("private details"));
        }
    }

    #[test]
    fn a_failed_refresh_preserves_the_successful_reading_and_its_age() {
        remember("stale-test", "Current session: 42% used");
        let read_at = read_at("stale-test").unwrap();
        remember_failure("stale-test", "offline");
        assert_eq!(recent_failure("stale-test").as_deref(), Some("offline"));
        assert_eq!(last_reading("stale-test").as_deref(), Some("Current session: 42% used"));
        assert_eq!(super::read_at("stale-test"), Some(read_at));
        remember("stale-test", "Current session: 43% used");
        assert!(recent_failure("stale-test").is_none());
        forget("stale-test");
    }


    #[test]
    fn usage_recipes_do_not_start_a_model_turn() {
        assert_eq!(
            usage_argv("claude").unwrap(),
            vec!["-p", "/usage", "--output-format", "json"]
        );
        assert!(is_supported("claude"));
        assert_eq!(usage_argv("codex").unwrap(), vec!["app-server", "--listen", "stdio://"]);
        assert!(is_supported("codex"));
        assert!(!is_supported("gemini"));
    }

    #[test]
    fn ansi_sequences_go_and_the_panel_stays() {
        assert_eq!(strip_ansi("\u{1b}[1mCurrent session\u{1b}[0m: 71%"), "Current session: 71%");
        assert_eq!(strip_ansi("\u{1b}]0;title\u{7}week"), "week");
        assert_eq!(strip_ansi("\u{1b}]8;;http://x\u{1b}\\link"), "link");
        // Box drawing is the panel, not decoration to remove.
        assert_eq!(strip_ansi("│ 71% │\r\n"), "│ 71% │\n");
    }

    #[test]
    fn the_envelope_result_is_the_panel() {
        let stdout = r#"{"type":"result","is_error":false,"num_turns":0,"result":"Current session: 71% used"}"#;
        assert_eq!(
            report_text(stdout, "", Some(0)).unwrap(),
            "Current session: 71% used"
        );
    }

    #[test]
    fn an_error_envelope_reports_the_clis_own_complaint() {
        let stdout = r#"{"type":"result","is_error":true,"result":"/status isn't available in this environment"}"#;
        assert_eq!(
            report_text(stdout, "", Some(0)).unwrap_err(),
            "/status isn't available in this environment"
        );
    }

    #[test]
    fn a_cli_that_drops_the_envelope_is_still_readable() {
        assert_eq!(
            report_text("Current week: 38% used\n", "", Some(0)).unwrap(),
            "Current week: 38% used"
        );
    }

    #[test]
    fn a_silent_failure_names_the_exit_status() {
        assert_eq!(
            report_text("", "", Some(1)).unwrap_err(),
            "the CLI exited with status 1 and printed nothing"
        );
        assert_eq!(
            report_text("", "not logged in", Some(1)).unwrap_err(),
            "not logged in"
        );
        assert_eq!(
            report_text("", "", None).unwrap_err(),
            "the CLI was stopped before it answered"
        );
    }

    #[test]
    fn a_run_that_prints_a_book_is_cut_and_says_so() {
        let flood = format!(r#"{{"result":"{}"}}"#, "x".repeat(MAX_USAGE_TEXT * 2));
        let text = report_text(&flood, "", Some(0)).unwrap();
        assert!(text.len() <= MAX_USAGE_TEXT + 4);
        assert!(text.ends_with('…'));
    }

    #[test]
    fn a_remembered_read_is_reused_until_it_is_forgotten() {
        remember("test-agent", "Current session: 5% used");
        assert_eq!(cached("test-agent").as_deref(), Some("Current session: 5% used"));
        forget("test-agent");
        assert!(cached("test-agent").is_none());
    }

    #[test]
    fn the_refresh_floor_is_shorter_than_the_cache_it_bypasses() {
        // A refresh that consulted the same window as a plain read could never
        // reach the CLI; one with no floor at all would spawn per tap.
        assert!(REFRESH_FLOOR < CACHE_TTL);
        remember("floor-agent", "fresh");
        assert!(cached_within("floor-agent", REFRESH_FLOOR).is_some());
        assert!(cached_within("floor-agent", Duration::from_nanos(1)).is_none());
        forget("floor-agent");
    }
}

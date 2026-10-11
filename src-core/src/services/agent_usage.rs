//! One agent CLI's own usage panel, read without opening a tab.
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

/// Per-agent argv that prints the CLI's usage panel once and exits, keyed by
/// the registry `id`. `claude` is the only entry because it is the only CLI
/// whose usage panel is reachable from print mode at all: `/status` answers
/// "isn't available in this environment" there, and no other agent documents a
/// non-interactive usage readout.
const RECIPES: &[(&str, &[&str])] = &[("claude", &["-p", "/usage", "--output-format", "json"])];

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

type Cache = Mutex<HashMap<String, (Instant, String)>>;

fn cache() -> &'static Cache {
    static CACHE: OnceLock<Cache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The last panel read for this agent, if it is younger than `max_age`.
pub fn cached_within(agent_id: &str, max_age: Duration) -> Option<String> {
    let cache = cache().lock().ok()?;
    let (at, text) = cache.get(agent_id)?;
    (at.elapsed() < max_age).then(|| text.clone())
}

/// The last panel read for this agent, if it is still inside `CACHE_TTL`.
pub fn cached(agent_id: &str) -> Option<String> {
    cached_within(agent_id, CACHE_TTL)
}

/// Keep a successful read for the next asker.
pub fn remember(agent_id: &str, text: &str) {
    if let Ok(mut cache) = cache().lock() {
        cache.insert(agent_id.to_string(), (Instant::now(), text.to_string()));
    }
}

/// Drop a cached read — what an explicit refresh does, so the button means
/// "ask the CLI again" rather than "show me the same minute-old answer".
pub fn forget(agent_id: &str) {
    if let Ok(mut cache) = cache().lock() {
        cache.remove(agent_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_claude_has_a_verified_usage_recipe() {
        assert_eq!(
            usage_argv("claude").unwrap(),
            vec!["-p", "/usage", "--output-format", "json"]
        );
        assert!(is_supported("claude"));
        assert!(usage_argv("codex").is_none());
        assert!(!is_supported("codex"));
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

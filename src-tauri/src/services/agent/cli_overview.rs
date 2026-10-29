//! The CLI overview: per agent CLI, the plan its login names and the usage
//! windows it last reported — the side panel's CLIs view and the phone's CLIs
//! section (`docs/cli_overview_plan.md`).
//!
//! Everything here is read, never asked for: the plan comes off Tabtivity's
//! own login store (`agent_auth`), which holds the one copy of each CLI's
//! credential file, and Codex's windows off the newest rollouts in the agent
//! homes, where every Codex turn writes them. Claude's windows are the
//! `agent_usage` panel, which the caller adds — it spawns a CLI, this module
//! does not.
//!
//! The credential files carry tokens. Only the named plan fields are taken
//! out of them; nothing else from those files leaves this module.

use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::services::agent_auth::{self, LoginStatus};
use crate::services::agent_home;
use crate::services::agent_transcript::{codex_usage, UsageWindow};
use crate::services::home_io::{self, HomeDir};

/// Rollouts tail-read at most per overview, newest first: the newest can be a
/// session that has not finished a turn yet, and so carries no limits.
const ROLLOUT_CANDIDATES: usize = 6;
/// How much of a rollout's end is read for its newest `token_count`.
const ROLLOUT_TAIL: u64 = 256 * 1024;
/// A JWT payload longer than this is not a Codex id token.
const MAX_JWT_PAYLOAD: usize = 64 * 1024;

/// The subscription a CLI's login names, as the file spells it.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CliPlan {
    /// `max`, `pro`, `plus`, `team`, … — formatted by the reader
    /// (`shared/cliOverview.ts` `planLabel`).
    pub name: String,
    /// Claude's `rateLimitTier` (`default_claude_max_5x`), where given.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier: Option<String>,
    /// Codex's `chatgpt_subscription_active_until`, RFC 3339, where given.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub until: Option<String>,
}

/// Usage windows read off a CLI's own records (Codex's rollouts).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CliLimits {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<UsageWindow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub week: Option<UsageWindow>,
    /// Unix seconds the record was last written: the figures are as of then.
    pub read_at: u64,
}

/// One CLI's row. `usage` (Claude's panel) is filled by the command.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliOverviewRow {
    pub id: String,
    pub label: String,
    pub signed_in: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<CliPlan>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limits: Option<CliLimits>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<CliUsagePanel>,
}

/// Claude's `/usage` panel as `agent_usage` read it: the text as printed, or
/// the fixed refusal code (never the error text, which can name local paths).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CliUsagePanel {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    pub cached: bool,
}

fn text_at(value: &Value, pointer: &str) -> Option<String> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.len() <= 64)
        .map(str::to_string)
}

/// Claude's plan, from its `.credentials.json`.
pub fn claude_plan(bytes: &[u8]) -> Option<CliPlan> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    Some(CliPlan {
        name: text_at(&value, "/claudeAiOauth/subscriptionType")?,
        tier: text_at(&value, "/claudeAiOauth/rateLimitTier"),
        until: None,
    })
}

/// Codex's plan, from the `id_token` claims in its `auth.json`. The token is
/// decoded, not verified: it is the CLI's own file, and the claim is shown,
/// never acted on.
pub fn codex_plan(bytes: &[u8]) -> Option<CliPlan> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let token = value.pointer("/tokens/id_token").and_then(Value::as_str)?;
    let payload = token.split('.').nth(1)?;
    if payload.len() > MAX_JWT_PAYLOAD {
        return None;
    }
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    let claims: Value = serde_json::from_slice(&decoded).ok()?;
    let auth = claims.get("https://api.openai.com/auth")?;
    Some(CliPlan {
        name: text_at(auth, "/chatgpt_plan_type")?,
        tier: None,
        until: text_at(auth, "/chatgpt_subscription_active_until"),
    })
}

/// The plan `cli`'s stored login names, for the CLIs whose file says one.
pub fn plan_in(state_dir: &Path, cli: &str) -> Option<CliPlan> {
    let rel = match cli {
        "claude" => ".claude/.credentials.json",
        "codex" => ".codex/auth.json",
        _ => return None,
    };
    let path = agent_auth::store_path_in(state_dir, cli, &agent_auth::file(rel));
    let bytes = home_io::read_record(&path)?;
    if cli == "claude" { claude_plan(bytes.as_bytes()) } else { codex_plan(bytes.as_bytes()) }
}

fn digits(name: &str) -> bool {
    !name.is_empty() && name.bytes().all(|b| b.is_ascii_digit())
}

fn descending(mut names: Vec<String>) -> Vec<String> {
    names.sort_unstable_by(|a, b| b.cmp(a));
    names
}

/// A home's newest rollouts by name (`rollout-<stamp>-<id>.jsonl` sorts by
/// time), at most `ROLLOUT_CANDIDATES`, walking `.codex/sessions/Y/M/D`
/// newest first without following a link.
fn newest_rollouts(home: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let Some(sessions) = HomeDir::open_existing(home, ".codex/sessions") else {
        return found;
    };
    for year in descending(sessions.names().into_iter().filter(|n| digits(n)).collect()) {
        for month in descending(
            HomeDir::open_existing(home, &format!(".codex/sessions/{year}"))
                .map(|d| d.names().into_iter().filter(|n| digits(n)).collect())
                .unwrap_or_default(),
        ) {
            for day in descending(
                HomeDir::open_existing(home, &format!(".codex/sessions/{year}/{month}"))
                    .map(|d| d.names().into_iter().filter(|n| digits(n)).collect())
                    .unwrap_or_default(),
            ) {
                let Some(dir) = HomeDir::open_existing(home, &format!(".codex/sessions/{year}/{month}/{day}")) else {
                    continue;
                };
                let names = dir
                    .names()
                    .into_iter()
                    .filter(|n| n.starts_with("rollout-") && n.ends_with(".jsonl"))
                    .collect();
                for name in descending(names) {
                    found.push(dir.path().join(name));
                    if found.len() >= ROLLOUT_CANDIDATES {
                        return found;
                    }
                }
            }
        }
    }
    found
}

fn unix_seconds(time: std::time::SystemTime) -> u64 {
    time.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Codex's newest rate-limit reading across every agent home: the most
/// recently written rollouts are tail-read until one carries limits.
pub fn codex_limits_in(state_dir: &Path) -> Option<CliLimits> {
    let mut candidates: Vec<(u64, PathBuf)> = agent_home::existing_homes_in(state_dir)
        .iter()
        .flat_map(|home| newest_rollouts(home))
        .filter_map(|path| {
            let modified = home_io::open_regular(&path)?.metadata().ok()?.modified().ok()?;
            Some((unix_seconds(modified), path))
        })
        .collect();
    candidates.sort_unstable_by_key(|(at, _)| std::cmp::Reverse(*at));
    for (read_at, path) in candidates.into_iter().take(ROLLOUT_CANDIDATES) {
        let Some(mut file) = home_io::open_regular(&path) else { continue };
        let Ok(meta) = file.metadata() else { continue };
        let Some((text, _)) =
            crate::services::agent_session::read_conversation_tail(&mut file, meta.len(), ROLLOUT_TAIL)
        else {
            continue;
        };
        let lines: Vec<&str> = text.lines().collect();
        let Some(usage) = codex_usage(&lines) else { continue };
        if usage.session.is_some() || usage.week.is_some() {
            return Some(CliLimits { session: usage.session, week: usage.week, read_at });
        }
    }
    None
}

/// The rows, without Claude's panel: every CLI that is signed in or whose
/// records say something, in registry order.
pub fn rows_in(state_dir: &Path, logins: &[LoginStatus]) -> Vec<CliOverviewRow> {
    let codex_limits = codex_limits_in(state_dir);
    logins
        .iter()
        .filter_map(|login| {
            let plan = plan_in(state_dir, &login.id);
            let limits = if login.id == "codex" { codex_limits.clone() } else { None };
            if !login.signed_in && plan.is_none() && limits.is_none() {
                return None;
            }
            Some(CliOverviewRow {
                id: login.id.clone(),
                label: crate::services::agent_registry::agent_label_for_id(&login.id)
                    .unwrap_or(login.id.as_str())
                    .to_string(),
                signed_in: login.signed_in,
                account: login.account.clone(),
                plan,
                limits,
                usage: None,
            })
        })
        .collect()
}

/// Most rows a phone answer carries; the registry is far smaller.
const MAX_PHONE_ROWS: usize = 64;

/// Whether a panel line names a local path — the rule `mobileUsageText`
/// (`lib/agents/agentUsage.ts`) applies to the per-tab status sheet.
fn names_local_path(line: &str) -> bool {
    // A word, and what follows each `:` in it (`log:/home/…`) — but the word
    // whole too, so a drive's `C:\` is still seen.
    let mut words = line
        .split(|c: char| c.is_whitespace() || "(\"'`=".contains(c))
        .flat_map(|word| std::iter::once(word).chain(word.split(':').skip(1)));
    words.any(|word| {
        let bytes = word.as_bytes();
        word.starts_with("~/")
            || word.starts_with("~\\")
            || word.starts_with("\\\\")
            || (bytes.len() > 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'/' | b'\\'))
            // `/a/…`: one named folder and a slash after it. A bare `/usage`
            // is a slash command, not a path.
            || word.strip_prefix('/').is_some_and(|rest| rest.split_once('/').is_some_and(|(first, _)| !first.is_empty()))
    })
}

/// The panel with every path-naming line replaced by `…`; `None` when
/// nothing readable is left.
fn phone_usage_text(raw: &str) -> Option<String> {
    let mut readable = false;
    let lines: Vec<&str> = raw
        .lines()
        .map(|line| {
            if names_local_path(line) {
                return "…";
            }
            readable |= !line.trim().is_empty();
            line
        })
        .collect();
    readable.then(|| lines.join("\n"))
}

/// The rows as a phone may see them: no account (an e-mail address), no
/// panel line that names a path on this machine, bounded.
pub fn for_phone(rows: Vec<CliOverviewRow>) -> Vec<CliOverviewRow> {
    rows.into_iter()
        .take(MAX_PHONE_ROWS)
        .filter(|row| (1..=64).contains(&row.id.len()) && row.label.len() <= 128)
        .map(|mut row| {
            row.account = None;
            if let Some(usage) = row.usage.as_mut() {
                usage.raw = usage.raw.as_deref().and_then(phone_usage_text);
                usage.code = usage.code.take().filter(|c| c.len() <= 32 && c.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'));
            }
            row
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jwt(claims: &Value) -> String {
        let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        format!("{}.{}.sig", engine.encode(b"{\"alg\":\"none\"}"), engine.encode(claims.to_string()))
    }

    fn login(id: &str, signed_in: bool) -> LoginStatus {
        LoginStatus {
            id: id.to_string(),
            signed_in,
            account: signed_in.then(|| format!("{id}@example.org")),
            importable: false,
            blocked: None,
            shared: true,
            admin_key_capable: false,
            admin_key_offered: false,
            uses_admin_key: false,
            api_key: false,
            api_budget_reached: false,
            api_key_saved: false,
            wellknown_homes: Vec::new(),
        }
    }

    fn store(state: &Path, cli: &str, rel: &'static str, body: &str) {
        let path = agent_auth::store_path_in(state, cli, &agent_auth::file(rel));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    fn token_count(primary: u64, secondary: u64) -> String {
        serde_json::json!({
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "rate_limits": {
                    "primary": { "used_percent": primary, "window_minutes": 300, "resets_at": 1_900_000_000u64 },
                    "secondary": { "used_percent": secondary, "window_minutes": 10080, "resets_at": 1_900_500_000u64 },
                },
            },
        })
        .to_string()
    }

    fn rollout(state: &Path, scope: &str, day: &str, name: &str, lines: &[String]) -> PathBuf {
        let dir = agent_home::scope_home_in(state, scope).join(".codex").join("sessions").join("2026").join("10").join(day);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();
        path
    }

    #[test]
    fn claude_plan_reads_only_the_plan_fields() {
        let body = r#"{"claudeAiOauth":{"accessToken":"secret","subscriptionType":"max","rateLimitTier":"default_claude_max_5x"}}"#;
        let plan = claude_plan(body.as_bytes()).unwrap();
        assert_eq!(plan, CliPlan { name: "max".into(), tier: Some("default_claude_max_5x".into()), until: None });
        assert!(!serde_json::to_string(&plan).unwrap().contains("secret"));
        assert_eq!(claude_plan(br#"{"claudeAiOauth":{"accessToken":"x"}}"#), None);
        assert_eq!(claude_plan(b"not json"), None);
    }

    #[test]
    fn codex_plan_comes_from_the_id_token_claims() {
        let claims = serde_json::json!({
            "https://api.openai.com/auth": { "chatgpt_plan_type": "plus", "chatgpt_subscription_active_until": "2026-11-26T07:19:50+00:00" }
        });
        let body = serde_json::json!({ "tokens": { "id_token": jwt(&claims), "access_token": "secret" } }).to_string();
        let plan = codex_plan(body.as_bytes()).unwrap();
        assert_eq!(plan.name, "plus");
        assert_eq!(plan.until.as_deref(), Some("2026-11-26T07:19:50+00:00"));
        let api_key_only = serde_json::json!({ "OPENAI_API_KEY": "sk-x" }).to_string();
        assert_eq!(codex_plan(api_key_only.as_bytes()), None);
        let garbled = serde_json::json!({ "tokens": { "id_token": "a.!!!.c" } }).to_string();
        assert_eq!(codex_plan(garbled.as_bytes()), None);
    }

    #[test]
    fn the_newest_rollout_with_limits_wins_across_homes() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path();
        let older = rollout(state, "p1", "27", "rollout-2026-10-27T10-00-00-a.jsonl", &[token_count(80, 40)]);
        let newer = rollout(state, "p2", "28", "rollout-2026-10-28T09-00-00-b.jsonl", &[token_count(12, 44)]);
        // The newest file has not finished a turn: no limits in it.
        let newest = rollout(state, "p1", "28", "rollout-2026-10-28T11-00-00-c.jsonl", &["{}".to_string()]);
        let now = std::time::SystemTime::now();
        let set = |p: &Path, ago: u64| {
            std::fs::File::options()
                .write(true)
                .open(p)
                .unwrap()
                .set_modified(now - std::time::Duration::from_secs(ago))
                .unwrap()
        };
        set(&older, 3600);
        set(&newer, 60);
        set(&newest, 10);
        let limits = codex_limits_in(state).unwrap();
        assert_eq!(limits.session, Some(UsageWindow { used: 12, resets_at: Some(1_900_000_000) }));
        assert_eq!(limits.week, Some(UsageWindow { used: 44, resets_at: Some(1_900_500_000) }));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_rollout_is_not_read() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path();
        let outside = state.join("outside.jsonl");
        std::fs::write(&outside, token_count(50, 50) + "\n").unwrap();
        let dir = agent_home::scope_home_in(state, "p1").join(".codex").join("sessions").join("2026").join("10").join("28");
        std::fs::create_dir_all(&dir).unwrap();
        std::os::unix::fs::symlink(&outside, dir.join("rollout-2026-10-28T09-00-00-a.jsonl")).unwrap();
        assert_eq!(codex_limits_in(state), None);
    }

    #[test]
    fn a_phone_row_has_no_account_and_no_local_path() {
        let mut row = rows_in(tempfile::tempdir().unwrap().path(), &[login("claude", true)]).remove(0);
        row.usage = Some(CliUsagePanel {
            raw: Some(
                "Current session: 4% used · resets 6pm\nLog: /home/u/.claude/debug.txt\nSee C:\\Users\\u\\x\nCurrent week (all models): 9% used".into(),
            ),
            code: Some("cli_error; rm".into()),
            cached: true,
        });
        let phone = for_phone(vec![row]).remove(0);
        assert_eq!(phone.account, None);
        let usage = phone.usage.unwrap();
        assert_eq!(
            usage.raw.as_deref(),
            Some("Current session: 4% used · resets 6pm\n…\n…\nCurrent week (all models): 9% used")
        );
        assert_eq!(usage.code, None);
        assert!(!names_local_path("Current week (all models): 54% used · resets Sep 17, 2pm (Europe/Berlin)"));
        assert!(!names_local_path("Last 24h: 41 requests · 6 sessions"));
    }

    #[test]
    fn rows_list_only_clis_with_something_to_say() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path();
        store(state, "claude", ".claude/.credentials.json", r#"{"claudeAiOauth":{"subscriptionType":"pro"}}"#);
        let rows = rows_in(state, &[login("claude", true), login("gemini", true), login("cursor", false)]);
        let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, ["claude", "gemini"]);
        assert_eq!(rows[0].plan.as_ref().map(|p| p.name.as_str()), Some("pro"));
        assert_eq!(rows[1].plan, None);
        assert_eq!(rows[0].account.as_deref(), Some("claude@example.org"));
    }
}

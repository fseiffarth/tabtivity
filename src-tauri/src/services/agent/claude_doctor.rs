//! What Manage CLIs reads from `claude doctor`: its "API connectivity"
//! section (Claude Code 2.1.331 and later).
//!
//! `claude doctor` (no TUI, plain text on stdout, exit 0) probes the API host
//! and the sign-in host from the machine, the way a session would reach them
//! (proxy, `ANTHROPIC_BASE_URL`, extra CA), and prints one verdict per host —
//! or one `Not tested:` line saying why it sent nothing. The section sits
//! between a blank line and the next blank line:
//!
//! ```text
//! API connectivity
//! - API (api.anthropic.com): answered HTTP 200 in 142 ms
//! - Sign-in (platform.claude.com): answered HTTP 200 in 161 ms
//! - ANTHROPIC_BASE_URL: not set · NODE_EXTRA_CA_CERTS: not set · …
//! ```
//!
//! A host line ends in `answered HTTP <n> in <ms> ms` (plus ` (expected 200)`
//! on an Anthropic host that answered something else), `no answer in <n> s`
//! or `failed after <ms> ms: <error>`; a host named by `ANTHROPIC_BASE_URL`
//! prints as `custom host`, and a request through a proxy says ` via <source>`.
//! [`parse`] reads that into an [`ApiCheck`]; [`check`] runs the CLI in the
//! probe home (the same spawn shape as the version probe) and parses what it
//! printed. Wording verified against 2.1.331, checklist §1.1.

use std::time::Duration;

use serde::Serialize;

use crate::services::agent_usage::strip_ansi;

/// First Claude release whose `doctor` prints the connectivity section. An
/// older one prints the rest of the report and no section ([`Verdict::Missing`]).
pub const SINCE: &str = "2.1.331";

/// `doctor` waits on the network (a host that never answers is called after
/// ten seconds) and on the organization-policy fetch, so it gets far longer
/// than a `--version` probe.
pub const TIMEOUT: Duration = Duration::from_secs(30);

/// Whether an installed version prints the section; an unknown one does not.
pub fn supported(version: Option<&str>) -> bool {
    version.is_some_and(|v| {
        crate::services::agent_versions::version_cmp(v, SINCE) != std::cmp::Ordering::Less
    })
}

/// One tested host: the API or the sign-in host.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    /// The host as `doctor` names it: `api.anthropic.com`, or `custom host`.
    pub host: String,
    /// What the request went through (`HTTPS_PROXY`), when it used a proxy.
    pub via: Option<String>,
    /// Something answered (any HTTP status).
    pub reachable: bool,
    pub status: Option<u16>,
    pub elapsed_ms: Option<u64>,
    /// Why it did not answer: `doctor`'s own words (code included), or
    /// `no answer in 10 s`.
    pub error: Option<String>,
    /// An Anthropic host answered, but not with the 200 `doctor` expects.
    pub unexpected: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Verdict {
    /// The API answered as expected.
    Ok,
    /// The API answered, but not with the status `doctor` expects.
    Unexpected,
    /// The API did not answer (refused, DNS, timeout).
    Unreachable,
    /// `doctor` sent nothing and says why ([`ApiCheck::not_tested`]).
    NotTested,
    /// This `doctor` printed no connectivity section (an older release, or a
    /// section it could not build).
    Missing,
}

/// The parsed section.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiCheck {
    pub verdict: Verdict,
    /// The API host answered (`None` when it was not tested or not listed).
    pub reachable: Option<bool>,
    pub status: Option<u16>,
    pub elapsed_ms: Option<u64>,
    pub error: Option<String>,
    /// The API host as `doctor` names it; empty when it was not tested.
    pub host: String,
    /// The API request went through a proxy.
    pub via: Option<String>,
    /// Why `doctor` sent no request, in its own words.
    pub not_tested: Option<String>,
    /// The sign-in host's line, when listed.
    pub sign_in: Option<Endpoint>,
    /// The section as printed (the `- …` lines and their continuations), so
    /// the card can show what `doctor` said beyond the verdict.
    pub lines: Vec<String>,
}

fn blank_check(verdict: Verdict) -> ApiCheck {
    ApiCheck {
        verdict,
        reachable: None,
        status: None,
        elapsed_ms: None,
        error: None,
        host: String::new(),
        via: None,
        not_tested: None,
        sign_in: None,
        lines: Vec::new(),
    }
}

/// The text after `prefix` in `s`, up to the first space, as a number.
fn number_after(s: &str, prefix: &str) -> Option<u64> {
    let rest = s.strip_prefix(prefix)?;
    rest.split_whitespace().next()?.parse().ok()
}

/// One host line (`- API (host) via X: <result>`) without its `- `.
/// `None` for any other line of the section.
fn parse_endpoint(line: &str) -> Option<(bool, Endpoint)> {
    let (is_api, rest) = if let Some(rest) = line.strip_prefix("API (") {
        (true, rest)
    } else {
        (false, line.strip_prefix("Sign-in (")?)
    };
    let (host, rest) = rest.split_once(')')?;
    let (via, body) = match rest.strip_prefix(" via ") {
        Some(after) => {
            let (via, body) = after.split_once(": ")?;
            (Some(via.to_string()), body)
        }
        None => (None, rest.strip_prefix(": ")?),
    };
    let mut endpoint = Endpoint {
        host: host.to_string(),
        via,
        ..Endpoint::default()
    };
    if let Some(answer) = body.strip_prefix("answered HTTP ") {
        endpoint.reachable = true;
        endpoint.status = answer.split_whitespace().next().and_then(|n| n.parse().ok());
        endpoint.elapsed_ms = answer.split_once(" in ").and_then(|(_, t)| number_after(t, ""));
        endpoint.unexpected = body.ends_with("(expected 200)");
    } else if let Some(failed) = body.strip_prefix("failed after ") {
        endpoint.elapsed_ms = number_after(failed, "");
        endpoint.error = Some(
            failed
                .split_once(" ms: ")
                .map(|(_, why)| why.trim().to_string())
                .unwrap_or_else(|| body.to_string()),
        );
    } else {
        // `no answer in 10 s`, or a form a later release adds: the line is
        // the reason, and nothing answered.
        endpoint.error = Some(body.trim().to_string());
    }
    Some((is_api, endpoint))
}

/// Read the "API connectivity" section out of `claude doctor`'s output.
pub fn parse(output: &str) -> ApiCheck {
    let text = strip_ansi(output);
    let mut lines = text.lines().map(str::trim_end);
    if !lines.any(|line| line.trim() == "API connectivity") {
        return blank_check(Verdict::Missing);
    }
    let section: Vec<String> = lines
        .take_while(|line| !line.trim().is_empty())
        .map(str::to_string)
        .collect();

    let mut check = blank_check(Verdict::Missing);
    let mut api = None;
    for line in &section {
        let Some(item) = line.strip_prefix("- ") else { continue };
        if let Some(why) = item.strip_prefix("Not tested:") {
            check.not_tested = Some(why.trim().to_string());
        } else if let Some((is_api, endpoint)) = parse_endpoint(item) {
            if is_api {
                api = Some(endpoint);
            } else {
                check.sign_in = Some(endpoint);
            }
        }
    }
    check.lines = section;
    if check.not_tested.is_some() {
        check.verdict = Verdict::NotTested;
    } else if let Some(api) = api {
        check.verdict = match (api.reachable, api.unexpected) {
            (true, false) => Verdict::Ok,
            (true, true) => Verdict::Unexpected,
            (false, _) => Verdict::Unreachable,
        };
        check.reachable = Some(api.reachable);
        check.status = api.status;
        check.elapsed_ms = api.elapsed_ms;
        check.error = api.error;
        check.host = api.host;
        check.via = api.via;
    }
    check
}

/// Run `claude doctor` the way the app runs Claude for a probe — the probe
/// home (the shared login, no hooks), the state dir as cwd so no project's
/// settings or trust prompt reach it, stdin closed, its own process group,
/// `kill_on_drop` — and read its connectivity section. `doctor` writes only
/// into that probe home (its `.claude.json`), never the user's.
pub async fn check() -> Result<ApiCheck, String> {
    use crate::services::agent_registry as registry;

    let spec = registry::find_spec("claude").ok_or_else(|| "Claude is not in the registry".to_string())?;
    let path = registry::resolve_spec_path(spec).ok_or_else(|| "Claude is not installed".to_string())?;
    let cwd = registry::warmup_dir()?;

    let mut std_cmd = crate::paths::command_no_window(&path);
    registry::into_probe_home(&mut std_cmd, spec, &cwd).await?;
    let mut cmd = tokio::process::Command::from(std_cmd);
    cmd.arg("doctor")
        // A probe never starts someone's CLI updating itself.
        .env("DISABLE_AUTOUPDATER", "1")
        .current_dir(&cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    {
        cmd.process_group(0);
    }
    let output = match tokio::time::timeout(TIMEOUT, async {
        cmd.spawn()
            .map_err(|e| format!("cannot start {}: {e}", path.display()))?
            .wait_with_output()
            .await
            .map_err(|e| format!("claude doctor did not run: {e}"))
    })
    .await
    {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => return Err(error),
        Err(_) => return Err(format!("claude doctor did not finish within {}s", TIMEOUT.as_secs())),
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let check = parse(&stdout);
    if check.verdict == Verdict::Missing && stdout.trim().is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let why = strip_ansi(&stderr);
        let why = why.trim();
        return Err(if why.is_empty() {
            format!("claude doctor printed nothing (exit status {:?})", output.status.code())
        } else {
            why.chars().take(300).collect()
        });
    }
    Ok(check)
}

#[cfg(test)]
mod tests {
    use super::*;

    const REACHABLE: &str = include_str!("../../../tests/fixtures/claude_doctor/reachable.txt");
    const REACHABLE_NO_LOGIN: &str = include_str!("../../../tests/fixtures/claude_doctor/reachable-no-login.txt");
    const PROXY_REFUSED: &str = include_str!("../../../tests/fixtures/claude_doctor/proxy-refused.txt");
    const CUSTOM_REFUSED: &str = include_str!("../../../tests/fixtures/claude_doctor/custom-host-refused.txt");
    const CUSTOM_DNS: &str = include_str!("../../../tests/fixtures/claude_doctor/custom-host-dns.txt");
    const NOT_TESTED: &str = include_str!("../../../tests/fixtures/claude_doctor/not-tested-gateway.txt");

    #[test]
    fn a_reachable_api_reads_status_and_time() {
        for text in [REACHABLE, REACHABLE_NO_LOGIN] {
            let check = parse(text);
            assert_eq!(check.verdict, Verdict::Ok);
            assert_eq!(check.reachable, Some(true));
            assert_eq!(check.status, Some(200));
            assert!(check.elapsed_ms.is_some());
            assert_eq!(check.host, "api.anthropic.com");
            assert_eq!(check.error, None);
            let sign_in = check.sign_in.expect("the sign-in host is listed");
            assert_eq!((sign_in.host.as_str(), sign_in.status), ("platform.claude.com", Some(200)));
            // The section stops at its blank line: Remote Control is not in it.
            assert_eq!(check.lines.len(), 3);
            assert!(check.lines[2].starts_with("- ANTHROPIC_BASE_URL: not set"));
        }
    }

    #[test]
    fn a_proxy_that_refuses_is_unreachable_and_named() {
        let check = parse(PROXY_REFUSED);
        assert_eq!(check.verdict, Verdict::Unreachable);
        assert_eq!(check.reachable, Some(false));
        assert_eq!(check.status, None);
        assert_eq!(check.via.as_deref(), Some("HTTPS_PROXY"));
        assert_eq!(check.elapsed_ms, Some(4));
        assert_eq!(
            check.error.as_deref(),
            Some("Connection refused \u{2014} a firewall or proxy may be blocking it (ECONNREFUSED)")
        );
        assert_eq!(check.sign_in.expect("sign-in").error.as_deref(), Some("ECONNREFUSED"));
        // The continuation line (indented) stays in the raw section.
        assert!(check.lines.last().unwrap().starts_with("  A proxy, firewall"));
    }

    #[test]
    fn a_custom_host_is_named_as_doctor_names_it() {
        let check = parse(CUSTOM_REFUSED);
        assert_eq!(check.verdict, Verdict::Unreachable);
        assert_eq!(check.host, "custom host");
        assert!(check.error.as_deref().unwrap().ends_with("(ECONNREFUSED)"));
        // The sign-in host still answered, and is told apart from the API.
        assert_eq!(check.sign_in.expect("sign-in").status, Some(200));

        let dns = parse(CUSTOM_DNS);
        assert_eq!(dns.verdict, Verdict::Unreachable);
        assert!(dns.error.as_deref().unwrap().ends_with("(ENOTFOUND)"));
    }

    #[test]
    fn a_session_that_sends_nothing_says_why() {
        let check = parse(NOT_TESTED);
        assert_eq!(check.verdict, Verdict::NotTested);
        assert_eq!(check.reachable, None);
        assert_eq!(
            check.not_tested.as_deref(),
            Some("this session uses a cloud provider or a gateway, or your settings name a gateway, not the Anthropic API")
        );
        assert!(check.sign_in.is_none());
    }

    #[test]
    fn an_unexpected_status_and_a_timeout_are_told_apart() {
        // Synthetic: no real capture of either (the wording is read from the
        // 2.1.331 binary: `answered HTTP <n> in <ms> ms` plus ` (expected
        // 200)` on an Anthropic host, `no answer in <n> s`).
        let unexpected = parse(
            "x\n\nAPI connectivity\n- API (api.anthropic.com): answered HTTP 403 in 88 ms (expected 200)\n- Sign-in (platform.claude.com): answered HTTP 200 in 90 ms\n\nnext\n",
        );
        assert_eq!(unexpected.verdict, Verdict::Unexpected);
        assert_eq!((unexpected.reachable, unexpected.status), (Some(true), Some(403)));

        let timeout = parse("API connectivity\n- API (api.anthropic.com): no answer in 10 s\n");
        assert_eq!(timeout.verdict, Verdict::Unreachable);
        assert_eq!(timeout.error.as_deref(), Some("no answer in 10 s"));

        // A custom host answering anything counts: `doctor` expects nothing of it.
        let custom = parse("API connectivity\n- API (custom host): answered HTTP 404 in 3 ms\n");
        assert_eq!(custom.verdict, Verdict::Ok);
        assert_eq!(custom.status, Some(404));
    }

    #[test]
    fn output_without_the_section_is_missing() {
        // 2.1.330 prints the rest of the report and no connectivity section.
        let check = parse("Claude Code doctor\n\nRunning: native (2.1.330)\n\nRemote Control\n- Not signed in\n");
        assert_eq!(check.verdict, Verdict::Missing);
        assert!(check.lines.is_empty());
        assert_eq!(parse("").verdict, Verdict::Missing);
        // "- Not tested" elsewhere in the report is not the section's.
        assert_eq!(parse("Remote Control\n- Not tested: x\n").verdict, Verdict::Missing);
    }

    #[test]
    fn ansi_colour_around_the_header_does_not_hide_it() {
        let check = parse("\u{1b}[1mAPI connectivity\u{1b}[0m\n- API (api.anthropic.com): answered HTTP 200 in 5 ms\n");
        assert_eq!(check.verdict, Verdict::Ok);
    }

    #[test]
    fn only_releases_with_the_section_are_offered_it() {
        assert!(supported(Some("2.1.331")));
        assert!(supported(Some("2.1.340")));
        assert!(supported(Some("2.2.0")));
        assert!(!supported(Some("2.1.330")));
        assert!(!supported(Some("2.0.999")));
        assert!(!supported(None));
    }
}

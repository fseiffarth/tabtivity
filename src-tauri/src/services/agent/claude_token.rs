//! Claude's long-lived token (`claude setup-token`) as the fallback login of
//! every Claude agent tab, local and remote.
//!
//! `claude setup-token` signs in once in the browser and prints a token
//! (`sk-ant-oat01-…`, a year by default) that it saves nowhere; Claude takes it
//! from [`TOKEN_ENV`] before its own stored login. Manage CLIs → Accounts &
//! keys opens a tab running it, and [`watch_setup_tab`] reads the token off
//! that tab's screen into the keyring (`remote_credentials`, account
//! [`ACCOUNT`]); a token made elsewhere can be pasted ([`save`]).
//!
//! **Fallback only.** Such a token is inference-only: Claude refuses Remote
//! Control on it ("requires a full-scope login token") and turns Claude in
//! Chrome off. So a tab gets it only while the shared login
//! (`services::agent_auth`) holds none for Claude — signed out, or the login
//! gone — and Tabtivity then leaves out `--remote-control`
//! ([`injects_local`]). A value the user set (this token, an API key, an auth
//! token) wins, and a tab on an API key (`agent_api_keys`) gets none.
//!
//! **Local.** The spawn carries it under its app-named carrier ([`CARRIER`],
//! in `tmux_local::SECRET_ENV`), which `agent_exec` maps to [`TOKEN_ENV`] in
//! front of the fence; Windows (no tmux, no fence) takes the name itself.
//! Never for a local-model tab, a locked project's tab, a container or a CLI
//! subcommand (a sign-in tab).
//!
//! **Remote** (`Settings::claude_token_remote`, absent = on). The token rides
//! ssh's encrypted environment channel as [`REMOTE_ENV`] (`SendEnv`, which a
//! stock sshd takes for `LC_*`), never the argv, and the remote command
//! exports [`TOKEN_ENV`] from it only when the host keeps no
//! `~/.claude/.credentials.json` of its own (`ssh_exec::remote_command`). In a
//! tmux-wrapped tab tmux 3.0+ copies it into the session through a fixed
//! `update-environment` slot. A host whose sshd refuses `LC_*`, or an older
//! tmux, simply runs on the host's own login.
//!
//! The agent can read the token in its environment — the same exposure as the
//! credentials file the shared login already copies into every agent home.
#![cfg_attr(windows, allow(dead_code))]

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;

/// The variable Claude reads a long-lived token from.
pub const TOKEN_ENV: &str = "CLAUDE_CODE_OAUTH_TOKEN";
/// Its carrier on Linux and macOS (`agent_exec::CARRIER_PREFIX` + the name;
/// `SECRET` keeps `brand::Pair::export_both` from twinning it).
pub const CARRIER: &str = crate::app_env!("AGENT_SECRET_CLAUDE_CODE_OAUTH_TOKEN");
/// Its name on the ssh environment channel to a remote host.
pub const REMOTE_ENV: &str = concat!("LC_", crate::app_upper!(), "_CLAUDE_OAUTH_TOKEN");
/// Keyring account under `remote_credentials`' service.
const ACCOUNT: &str = "agent-token:claude";
/// Every token `claude setup-token` prints starts so.
const PREFIX: &str = "sk-ant-oat";
/// Variables that already choose Claude's credential; any of them in the
/// spawn's or Tabtivity's environment wins over the stored token.
const USER_SET: &[&str] = &[TOKEN_ENV, "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR"];
/// How long a setup tab is watched, and how often.
const WATCH_FOR: Duration = Duration::from_secs(30 * 60);
const WATCH_EVERY: Duration = Duration::from_secs(2);

/// What Manage CLIs shows. Never the token.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeTokenStatus {
    /// A token is saved.
    pub saved: bool,
    /// New local Claude tabs run on it now: no shared login holds one.
    pub in_use: bool,
    /// Remote Claude tabs get it too (`Settings::claude_token_remote`).
    pub remote: bool,
    /// Saves since this process started, so a view that opened a setup tab
    /// sees a new token replace an old one.
    pub revision: u64,
}

static SAVES: AtomicU64 = AtomicU64::new(0);

/// A plausible token: the prefix, then the base64url alphabet, bounded.
pub fn token_shape_ok(token: &str) -> bool {
    token.starts_with(PREFIX)
        && (40..=400).contains(&token.len())
        && token.bytes().all(is_token_byte)
}

fn is_token_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'-' || b == b'_'
}

/// A terminal's output as plain lines: escape sequences removed, a cursor
/// move or carriage return read as a line break (tmux paints a row by moving
/// to it, and Ink wraps a long word over rows).
pub fn plain_text(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\u{1b}' => match chars.next() {
                Some('[') => {
                    // CSI: parameters, then one final byte 0x40–0x7E.
                    let mut last = None;
                    for c in chars.by_ref() {
                        if ('\u{40}'..='\u{7e}').contains(&c) {
                            last = Some(c);
                            break;
                        }
                    }
                    if matches!(last, Some('H' | 'f' | 'A' | 'B' | 'E' | 'F' | 'd')) {
                        out.push('\n');
                    }
                }
                Some(']') | Some('P') | Some('_') | Some('^') => {
                    // OSC / DCS / APC / PM: up to BEL or ST.
                    while let Some(c) = chars.next() {
                        if c == '\u{7}' {
                            break;
                        }
                        if c == '\u{1b}' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                _ => {}
            },
            '\r' => out.push('\n'),
            c if c == '\n' || c == '\t' || !c.is_control() => out.push(c),
            _ => {}
        }
    }
    out
}

/// The token `claude setup-token` printed in `screen` (plain lines), if a
/// whole one is there. Ink breaks a token wider than the pane over several
/// rows, so the rows after it made only of token characters belong to it.
/// Whole means some other text follows (Claude prints "Store this token…"
/// next): a screen read mid-print, cut inside the token, gives nothing. The
/// last whole token wins.
pub fn find_token(screen: &str) -> Option<String> {
    let lines: Vec<&str> = screen.lines().map(str::trim).collect();
    let mut found = None;
    for (i, line) in lines.iter().enumerate() {
        let Some(at) = line.find(PREFIX) else { continue };
        let head: String = line[at..].bytes().take_while(|b| is_token_byte(*b)).map(char::from).collect();
        let rest = &line[at + head.len()..];
        let mut token = head;
        let mut next = i + 1;
        if rest.is_empty() {
            while let Some(more) = lines.get(next) {
                if more.is_empty() || !more.bytes().all(is_token_byte) || token.len() > 400 {
                    break;
                }
                token.push_str(more);
                next += 1;
            }
        }
        let followed = !rest.trim().is_empty() || lines[next..].iter().any(|l| !l.is_empty());
        if followed && token_shape_ok(&token) {
            found = Some(token);
        }
    }
    found
}

fn stored() -> Option<String> {
    crate::services::remote_credentials::get(ACCOUNT).filter(|t| token_shape_ok(t))
}

/// Save `token` (a pasted one, or one read off a setup tab).
pub fn save(token: &str) -> Result<(), String> {
    let token = token.trim();
    if !token_shape_ok(token) {
        return Err("not a Claude token — `claude setup-token` prints one starting with sk-ant-oat".into());
    }
    crate::services::remote_credentials::set(ACCOUNT, Some(token))?;
    SAVES.fetch_add(1, Ordering::Relaxed);
    Ok(())
}

/// Forget the saved token. Running tabs keep theirs.
pub fn clear() -> Result<(), String> {
    crate::services::remote_credentials::set(ACCOUNT, None)
}

fn shared_login() -> bool {
    crate::services::agent_auth::signed_in_in(&crate::storage::state_dir(), "claude")
}

fn settings_remote() -> bool {
    crate::storage::read_json::<crate::schema::Settings>(&crate::storage::settings_path())
        .map(|s| s.claude_token_remote())
        .unwrap_or(true)
}

pub fn status() -> ClaudeTokenStatus {
    let saved = stored().is_some();
    ClaudeTokenStatus {
        saved,
        in_use: saved && !shared_login(),
        remote: settings_remote(),
        revision: SAVES.load(Ordering::Relaxed),
    }
}

fn ambient(name: &str) -> bool {
    std::env::var_os(name).is_some_and(|v| !v.is_empty())
}

/// Whether a spawn of `cmd args` with `env` may get the token at all, before
/// any login or keyring is read: a Claude session (no subcommand), not a
/// local-model tab, nothing the user set, no API key put in for it.
fn candidate(cmd: &str, args: &[String], local_model: bool, env: &HashMap<String, String>, ambient: impl Fn(&str) -> bool) -> bool {
    crate::services::agent_api_keys::cli_of(cmd) == Some("claude")
        && !local_model
        && !crate::services::agent_api_keys::keyless_subcommand(cmd, args)
        && !USER_SET.iter().any(|k| env.contains_key(*k) || ambient(k))
        && !env.contains_key(crate::services::agent_api_keys::ANTHROPIC_CARRIER)
        && !env.contains_key(CARRIER)
}

/// The pure core of [`inject_launch`]: puts `token()` in `env` (under its
/// carrier with `carry`) when the spawn is a candidate and `signed_in` is
/// false. Returns whether it did.
pub(crate) fn inject_env_with(
    cmd: &str,
    args: &[String],
    local_model: bool,
    env: &mut HashMap<String, String>,
    carry: bool,
    ambient: impl Fn(&str) -> bool,
    signed_in: impl FnOnce() -> bool,
    token: impl FnOnce() -> Option<String>,
) -> bool {
    if !candidate(cmd, args, local_model, env, ambient) || signed_in() {
        return false;
    }
    let Some(token) = token() else { return false };
    env.insert(if carry { CARRIER } else { TOKEN_ENV }.to_string(), token);
    true
}

/// Give a local Claude spawn the saved token when no shared login holds one.
/// Call where `agent_api_keys::inject_launch` runs (while `opts` still names
/// the CLI, and after it), and not for a locked project's tab.
pub(crate) fn inject_launch(opts: &mut crate::terminal::PtyOptions) -> bool {
    let local_model = crate::services::agent_api_keys::is_local_model(opts);
    inject_env_with(&opts.cmd, &opts.args, local_model, &mut opts.env, cfg!(unix), ambient, shared_login, stored)
}

/// Whether [`inject_launch`] will give this local spawn the token — so the
/// caller leaves out `--remote-control`, which Claude refuses on it.
pub(crate) fn injects_local(opts: &crate::terminal::PtyOptions, remote_agent_run: bool) -> bool {
    !remote_agent_run
        && !opts.sandbox
        && !crate::services::agent_privacy::stamped(opts)
        && candidate(&opts.cmd, &opts.args, crate::services::agent_api_keys::is_local_model(opts), &opts.env, ambient)
        && !shared_login()
        && stored().is_some()
}

/// Give a remote Claude spawn the saved token as [`REMOTE_ENV`], for
/// `ssh_exec::wrap_pty_options` to send. The host decides whether to use it.
pub(crate) fn inject_remote(opts: &mut crate::terminal::PtyOptions) {
    if crate::services::agent_privacy::stamped(opts) {
        return;
    }
    let local_model = crate::services::agent_api_keys::is_local_model(opts);
    if !candidate(&opts.cmd, &opts.args, local_model, &opts.env, |_| false) || !settings_remote() {
        return;
    }
    if let Some(token) = stored() {
        opts.env.insert(REMOTE_ENV.to_string(), token);
    }
}

/// The remote shell's line that turns [`REMOTE_ENV`] into [`TOKEN_ENV`]
/// unless the host has its own login, and with `unset` drops [`REMOTE_ENV`]
/// (an `LC_*` name a later `ssh` from the agent would forward). A group, so
/// it chains with `&&` and always succeeds.
pub fn remote_export_line(unset: bool) -> String {
    let unset = if unset { format!(" unset {REMOTE_ENV};") } else { String::new() };
    format!(
        "{{ if [ -n \"${{{REMOTE_ENV}:-}}\" ] && [ ! -s \"$HOME/.claude/.credentials.json\" ]; then export {TOKEN_ENV}=\"${REMOTE_ENV}\"; fi;{unset} }}"
    )
}

/// Whether `cmd args` (the spawn before any wrap) runs `claude setup-token`.
pub fn is_setup_token(cmd: &str, args: &[String]) -> bool {
    crate::services::agent_api_keys::cli_of(cmd) == Some("claude") && args.first().is_some_and(|a| a == "setup-token")
}

/// Read the token off a local setup tab once it prints one, and save it:
/// from its tmux session's screen when it has one (clean rows), else from the
/// PTY's retained output. Gives up after [`WATCH_FOR`]. Nothing is logged.
pub fn watch_setup_tab(pty_id: String, tmux_session: Option<String>) {
    let spawned = std::thread::Builder::new().name("claude-token-watch".into()).spawn(move || {
        let start = Instant::now();
        // One save per token: a locked keyring must not be asked every tick.
        let mut tried: Option<String> = None;
        while start.elapsed() < WATCH_FOR {
            std::thread::sleep(WATCH_EVERY);
            let scrollback = crate::terminal::route_scrollback(&pty_id);
            let screen = tmux_session
                .as_deref()
                .and_then(tmux_screen)
                .unwrap_or_else(|| plain_text(&scrollback.data));
            if let Some(token) = find_token(&screen) {
                if tried.as_deref() != Some(token.as_str()) {
                    if save(&token).is_ok() {
                        return;
                    }
                    tried = Some(token);
                }
            }
            // The tab ended: its last screen was read above.
            if scrollback.exited && tmux_session.is_none() {
                return;
            }
        }
    });
    if spawned.is_err() {
        eprintln!("claude_token: could not start the setup-tab watcher");
    }
}

/// The screen and recent history of local tmux `session`, wrapped rows
/// joined. `None` when there is no such session.
fn tmux_screen(session: &str) -> Option<String> {
    if !crate::services::ssh_exec::valid_tmux_session_name(session) || !crate::services::tmux_local::tmux_available() {
        return None;
    }
    let mut args = crate::services::tmux_local::local_tmux_screen_args(session);
    args.extend(["-S".into(), "-200".into()]);
    let output = crate::services::tmux_local::tmux_command().args(args).output().ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A token-shaped value built at run time, so no literal reads as one.
    fn fake(fill: char, len: usize) -> String {
        format!("{PREFIX}01-{}", fill.to_string().repeat(len))
    }

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn shapes() {
        assert!(token_shape_ok(&fake('a', 90)));
        assert!(!token_shape_ok(&fake('a', 5)));
        assert!(!token_shape_ok(&format!("{} x", fake('a', 90))));
        assert!(!token_shape_ok(&format!("sk-ant-api03-{}", "a".repeat(90))));
        assert!(!token_shape_ok(""));
    }

    #[test]
    fn finds_a_token_on_one_row() {
        let token = fake('b', 95);
        let screen = format!("✓ Long-lived authentication token created successfully!\n\nYour OAuth token (valid for 1 year):\n\n  {token}\n\nStore this token securely. You won't be able to see it again.\n");
        assert_eq!(find_token(&screen), Some(token));
    }

    #[test]
    fn joins_a_token_ink_wrapped_over_rows() {
        let token = fake('c', 95);
        let (a, b) = token.split_at(60);
        let screen = format!("Your OAuth token (valid for 1 year):\n\n{a}\n{b}\n\nStore this token securely.\n");
        assert_eq!(find_token(&screen), Some(token));
    }

    #[test]
    fn a_token_cut_mid_print_is_not_taken() {
        let token = fake('d', 95);
        let (a, _) = token.split_at(70);
        assert_eq!(find_token(&format!("Your OAuth token (valid for 1 year):\n\n{a}")), None);
        assert_eq!(find_token(&format!("Your OAuth token:\n\n{token}\n\n")), None);
    }

    #[test]
    fn plain_text_strips_colour_and_breaks_at_cursor_moves() {
        let token = fake('e', 95);
        let (a, b) = token.split_at(50);
        let raw = format!("\u{1b}[?25l\u{1b}]0;title\u{7}\u{1b}[33m{a}\u{1b}[5;1H{b}\u{1b}[39m\r\n\u{1b}[2mStore this token securely.\u{1b}[22m");
        assert_eq!(find_token(&plain_text(&raw)), Some(token));
    }

    #[test]
    fn injects_only_for_a_claude_session_without_a_login() {
        let token = fake('f', 90);
        let run = |cmd: &str, a: &[&str], local_model: bool, env: &mut HashMap<String, String>, signed_in: bool| {
            inject_env_with(cmd, &args(a), local_model, env, true, |_| false, || signed_in, || Some(token.clone()))
        };
        let mut env = HashMap::new();
        assert!(run("claude", &[], false, &mut env, false));
        assert_eq!(env.get(CARRIER), Some(&token));
        assert!(!env.contains_key(TOKEN_ENV));

        for (cmd, a, local_model, signed_in) in [
            ("claude", &[][..], false, true),
            ("claude", &["setup-token"][..], false, false),
            ("claude", &["auth", "login"][..], false, false),
            ("claude", &[][..], true, false),
            ("codex", &[][..], false, false),
        ] {
            let mut env = HashMap::new();
            assert!(!run(cmd, a, local_model, &mut env, signed_in), "{cmd} {a:?}");
            assert!(env.is_empty());
        }
        for user in [TOKEN_ENV, "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", crate::services::agent_api_keys::ANTHROPIC_CARRIER] {
            let mut env = HashMap::from([(user.to_string(), "x".to_string())]);
            assert!(!run("claude", &[], false, &mut env, false), "{user}");
        }
        let mut env = HashMap::new();
        assert!(!inject_env_with("claude", &[], false, &mut env, true, |k| k == "ANTHROPIC_API_KEY", || false, || Some(token.clone())));
        let mut env = HashMap::new();
        assert!(inject_env_with("claude", &[], false, &mut env, false, |_| false, || false, || Some(token.clone())));
        assert_eq!(env.get(TOKEN_ENV), Some(&token));
    }

    #[test]
    fn the_carrier_is_a_secret_slot_and_maps_to_the_variable() {
        assert_eq!(CARRIER, crate::services::agent_exec::carrier_name(TOKEN_ENV));
        assert!(crate::services::tmux_local::SECRET_ENV.contains(&CARRIER));
        assert!(!crate::services::tmux_local::SECRET_ENV.contains(&TOKEN_ENV));
        assert!(crate::services::agent_exec::targets().contains(&TOKEN_ENV));
    }

    /// The remote line in a real shell: the token becomes the variable only
    /// where the host keeps no login, and the channel's name is dropped.
    #[cfg(unix)]
    #[test]
    fn the_remote_line_uses_the_token_only_without_a_host_login() {
        let home = tempfile::tempdir().unwrap();
        let run = || {
            let script = format!("{} && echo \"${{{TOKEN_ENV}:-none}}|${{{REMOTE_ENV}:-gone}}\"", remote_export_line(true));
            let out = std::process::Command::new("sh")
                .arg("-c")
                .arg(script)
                .env_clear()
                .env("HOME", home.path())
                .env(REMOTE_ENV, "tok")
                .output()
                .unwrap();
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        assert_eq!(run(), "tok|gone");
        std::fs::create_dir_all(home.path().join(".claude")).unwrap();
        std::fs::write(home.path().join(".claude").join(".credentials.json"), "{}").unwrap();
        assert_eq!(run(), "none|gone");
    }

    #[test]
    fn setup_token_spawns() {
        assert!(is_setup_token("claude", &args(&["setup-token"])));
        assert!(is_setup_token("/usr/local/bin/claude", &args(&["setup-token"])));
        assert!(!is_setup_token("claude", &args(&["auth", "login"])));
        assert!(!is_setup_token("codex", &args(&["setup-token"])));
    }
}

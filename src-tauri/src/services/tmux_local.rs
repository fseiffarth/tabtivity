//! Persistent **local** (tmux) sessions (TODO #85 extension).
//!
//! The remote half of persistent sessions runs tmux on the SSH host; this runs it
//! on the **local machine** so a local project's shell/script tab (a Python run, a
//! long build) keeps going if Tabtivity **crashes** — and reattaches on restart —
//! instead of dying with the PTY. It works because the tmux **server** is a
//! daemon: the PTY only holds a tmux *client*, so when Tabtivity (and the client)
//! goes away the session and its processes live on under the server, and a
//! respawn's `tmux new-session -A` reattaches them.
//!
//! **Unix only.** There is no tmux on Windows, so every entry point here no-ops
//! there (guarded by [`tmux_available`], which is `false` on Windows), leaving the
//! tab to spawn exactly as before.
//!
//! Unlike the remote wrap (which emits a `$SHELL -c` *string* for ssh), the local
//! wrap rewrites `PtyOptions.{cmd,args}` into a direct `tmux` **argv** — the PTY
//! spawns `tmux` itself, and the `cwd` set on the client is inherited by a
//! freshly-created session. Its `env` is **not**: tmux gives a new session the
//! *server's* global environment, so per-tab variables have to be handed to
//! `new-session` explicitly ([`local_tmux_args`]).

use std::collections::HashMap;

use crate::services::ssh_exec::{is_valid_env_key, shell_quote, TMUX_HISTORY_LINES};
use crate::terminal::PtyOptions;

/// Prefix reserved for tmux sessions Tabtivity creates on the local machine.
///
/// It is deliberately broad enough to include sessions created by a previous
/// Tabtivity run and whose tabs have not been opened in this run yet. A clean app
/// quit reaps these sessions ([`kill_app_sessions`]), while a crash leaves
/// them available for restore.
pub const LOCAL_TMUX_PREFIX: &str = crate::brand::TMUX_PREFIX;

/// What the tmux **client** can hand its server in one message. The argv is
/// sent as a single imsg and refused with `command too long` (the tab then
/// shows nothing but `[process exited]`) once every item plus its NUL
/// terminator exceeds `MAX_IMSGSIZE` (16384 in every tmux release). A fenced
/// agent tab hit this: the bubblewrap wrap emits one `--bind`/`--ro-bind`
/// item pair per `~/.claude`/`~/.codex` entry and per transcript dir, so a
/// well-used machine's fence alone runs to tens of kilobytes — and a
/// Mobile-reachable agent tab nests all of it inside the tmux command line.
pub const TMUX_ARGV_LIMIT: usize = 16384;

/// Above this the command line moves into a [`launcher_script`] instead of
/// riding the tmux argv. Well under [`TMUX_ARGV_LIMIT`]: the message also
/// carries a header and the client's own cwd/environment bookkeeping, and the
/// limit is an unrecoverable launch failure rather than a slowdown.
const TMUX_ARGV_BUDGET: usize = 12 * 1024;

/// The bytes a tmux client sends for `args` — each item and its terminator —
/// which is exactly what it measures against [`TMUX_ARGV_LIMIT`].
pub fn argv_bytes(args: &[String]) -> usize {
    args.iter().map(|a| a.len() + 1).sum()
}

/// Which of a `tmux ls` listing's sessions a clean quit ends: every session
/// Tabtivity minted, and nothing else. Pure, so the ownership rule is tested
/// without a tmux server.
pub fn sessions_to_reap<'a>(names: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    names
        .into_iter()
        .filter(|name| is_app_local_tmux_session(name))
        .map(str::to_string)
        .collect()
}

/// Whether a `tmux kill-session` failure means the session was already gone —
/// which is the desired end state, not an error. A session can exit between
/// `ls` and `kill-session`, and the server itself goes away with its last one —
/// a kill that reaches it while it is exiting reads "server exited
/// unexpectedly" (seen on CI's tmux, 2026-10-02).
pub fn kill_failure_is_already_gone(stderr: &str) -> bool {
    stderr.contains("can't find session")
        || stderr.contains("no server running")
        || stderr.contains("failed to connect to server")
        || stderr.contains("server exited unexpectedly")
}

/// End every tmux session Tabtivity created on the local machine — the clean-quit
/// reap (TODO #85). Blocking; callers off the main thread wrap it in
/// `spawn_blocking`, the exit path runs it inline.
///
/// This deliberately lists the daemon rather than only the tabs currently
/// hydrated in the frontend: a session recovered from an earlier crash may
/// belong to an inactive project and therefore have no mounted tab in this run
/// yet. The `tabtivity-` prefix is reserved for sessions Tabtivity mints, so
/// user-managed sessions are never affected.
///
/// Reached from two places on purpose: the frontend's close handler (the
/// window's ×) and the backend's `RunEvent::Exit` net, which also catches the
/// exits that never run frontend code — a SIGTERM/SIGINT from the dev launcher,
/// an `app.exit()`. A renderer or process crash reaches neither, leaving the
/// sessions alive for restore.
pub fn kill_app_sessions() -> Result<(), String> {
    if !tmux_available() {
        return Ok(());
    }
    let listed = crate::paths::command_no_window("tmux")
        .args(local_tmux_ls_args())
        .output()
        .map_err(|e| format!("could not list tmux sessions: {e}"))?;
    // `tmux ls` returns non-zero when no server is running, which is already
    // the desired end state for the quit path.
    if !listed.status.success() {
        return Ok(());
    }
    let sessions = crate::services::ssh_exec::parse_tmux_ls(&String::from_utf8_lossy(&listed.stdout));
    let mut failures = Vec::new();
    for name in sessions_to_reap(sessions.iter().map(|s| s.name.as_str())) {
        let output = crate::paths::command_no_window("tmux")
            .args(local_tmux_kill_args(&name))
            .output()
            .map_err(|e| format!("could not run tmux: {e}"))?;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            if !kill_failure_is_already_gone(&detail) {
                failures.push(if detail.is_empty() {
                    name
                } else {
                    format!("{name}: {detail}")
                });
            }
        }
    }
    // Every Tabtivity session is ending here, so every launcher is stale too.
    let _ = std::fs::remove_dir_all(crate::storage::state_dir().join("tmux-launch"));
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!(
            concat!("could not stop every ", crate::app_name!(), " local tmux session: {}"),
            failures.join("; ")
        ))
    }
}

/// Whether a local tmux session is owned by Tabtivity.
///
/// Session names are minted by the frontend as `tabtivity-<scope>--…`; keeping the
/// ownership rule here means the quit path never touches a user-created session
/// such as `train` or `work`.
pub fn is_app_local_tmux_session(session: &str) -> bool {
    // Under the current prefix, or the one an older build minted.
    crate::services::brand_migration::compat::tmux_session_rest(&crate::brand::PAIR, session).is_some()
}

/// The tab variables worth putting in a session's environment, sorted so the
/// argv is deterministic (and testable).
///
/// `is_valid_env_key` keeps a key with shell metacharacters out of the `export`
/// fallback, where it would sit unquoted left of `=`. `TERM`/`COLORTERM` are
/// tmux's own to set per pane — feeding it the outer terminal's `TERM` is how a
/// pane ends up disagreeing with the terminal it is drawn in.
fn session_env_pairs(env: &HashMap<String, String>) -> Vec<(&str, &str)> {
    let mut pairs: Vec<(&str, &str)> = env
        .iter()
        .filter(|(k, _)| {
            is_valid_env_key(k) && k.as_str() != "TERM" && k.as_str() != "COLORTERM"
        })
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    pairs.sort_by(|a, b| a.0.cmp(b.0));
    pairs
}

/// Whether this machine's tmux understands `new-session -e` (added in 3.2).
/// Cached like [`tmux_available`]; the answer cannot change within a run.
#[cfg(unix)]
pub(crate) fn tmux_supports_session_env() -> bool {
    use std::sync::OnceLock;
    static SUPPORTED: OnceLock<bool> = OnceLock::new();
    *SUPPORTED.get_or_init(|| {
        crate::paths::command_no_window("tmux")
            .arg("-V")
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| version_supports_session_env(&String::from_utf8_lossy(&o.stdout)))
            .unwrap_or(false)
    })
}

#[cfg(not(unix))]
pub(crate) fn tmux_supports_session_env() -> bool {
    false
}

/// Parse `tmux -V` output for the `new-session -e` floor (3.2). Unrecognized
/// output is treated as *not* supporting it: emitting an unknown flag would make
/// every persistent tab fail to start, while the `export` fallback keeps the
/// case that matters (an agent tab) working.
#[cfg(any(unix, test))]
fn version_supports_session_env(v_output: &str) -> bool {
    let rest = v_output.trim();
    let rest = rest.strip_prefix("tmux").unwrap_or(rest).trim();
    // Development builds ("master", "next-3.6") are past 3.2 by construction.
    let rest = match rest.strip_prefix("next-") {
        Some(r) => r,
        None if rest.starts_with("master") => return true,
        None => rest,
    };
    let digits: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let mut parts = digits.split('.');
    let major: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let minor: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    (major, minor) >= (3, 2)
}

/// Whether a usable `tmux` is on `PATH`. Cached after the first probe (the answer
/// cannot change within a run). Always `false` on Windows, which is what makes
/// every wrap here a no-op there.
#[cfg(unix)]
pub fn tmux_available() -> bool {
    use std::sync::OnceLock;
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    *AVAILABLE.get_or_init(|| {
        crate::paths::command_no_window("tmux")
            .arg("-V")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    })
}

#[cfg(not(unix))]
pub fn tmux_available() -> bool {
    false
}

/// Build the `tmux` argv (the value of `PtyOptions.args`, with `cmd` = `"tmux"`)
/// that spawns-or-attaches the session named `session`. Pure + unit-testable.
///
/// `target_cmd` empty ⇒ a bare `new-session` whose command is tmux's default
/// (the login shell) — the shell-tab / typed-command case (e.g. a Python run typed
/// into the shell), where the shell **outlives** the command so the session
/// survives its completion. `target_cmd` set (a command tab) ⇒ tmux runs
/// `<cmd> <args>; exec "$SHELL" -l`, i.e. the command, then a login shell, so the
/// session likewise persists after the command exits (reattach shows the result
/// rather than re-running it — the resumable-command-tab guarantee).
///
/// `-A` = attach if it exists / create otherwise (one command that is both start
/// and resume). Attach is deliberately non-evicting so desktop and phone clients
/// coexist. `status off` / `mouse on` / `window-size largest` are session-scoped
/// after a literal `;` argv item (tmux splits its argv on a standalone `;`).
/// `history-limit` alone comes **before** `new-session` and is `-g`: a pane
/// copies the limit at creation, so a `-t`-scoped set after the fact would leave
/// the session's one pane at tmux's default 2000 — see
/// [`ssh_exec::TMUX_HISTORY_LINES`](crate::services::ssh_exec::TMUX_HISTORY_LINES),
/// which also sizes the phone replay.
/// `env` is the tab's own environment, which a pane does **not** otherwise get:
/// tmux builds a new session's environment from the *server's* global one (fixed
/// when the server started), not from the client that creates the session, so
/// every tab after the first inherited the founding tab's variables. That is what
/// silently broke agent resume — Claude's `SessionStart` hook keys by
/// `$TABTIVITY_TAB_UID`, saw the wrong value or none, wrote no
/// `live_sessions/<uid>` record, and `agent_session::resolve_*` then had nothing
/// to resume but the tab's original launch id (i.e. the conversation as it was
/// when the tab was first opened). See [`local_tmux_args_with`] for how the
/// variables are carried.
pub fn local_tmux_args(
    session: &str,
    target_cmd: &str,
    target_args: &[String],
    env: &HashMap<String, String>,
) -> Vec<String> {
    local_tmux_args_with(
        session,
        target_cmd,
        target_args,
        env,
        tmux_supports_session_env(),
    )
}

/// Testable core of [`local_tmux_args`]. `session_env` = the local tmux accepts
/// `new-session -e` (3.2+), which is the mechanism that carries `env` for **both**
/// tab kinds. Without it a command tab still gets its variables — they are
/// `export`ed at the head of the command line tmux runs — while a bare shell tab
/// keeps the pre-fix behavior, since there is no command line to prefix and
/// overriding tmux's `default-command` to synthesize one would take the user's
/// own `~/.tmux.conf` out of the loop. The [`SECRET_ENV`] tokens are the one
/// exception to `-e`: they reach the session through `update-environment` from
/// the client's environment, never as a value on argv (#864).
///
/// Only a freshly *created* session is reached either way: `-A` on an existing
/// one attaches, and its pane keeps the process (and environment) it was started
/// with. That is the intended resume behavior, not a gap in this.
fn local_tmux_args_with(
    session: &str,
    target_cmd: &str,
    target_args: &[String],
    env: &HashMap<String, String>,
    session_env: bool,
) -> Vec<String> {
    let line = command_line(target_cmd, target_args, env, session_env);
    local_tmux_args_for(session, line.as_deref(), env, session_env, is_fence(target_cmd, env))
}

/// Whether the tab's command is an agent fence (`agent_fence` has already
/// rewritten a fenced agent's command to its sandbox launcher by now). On
/// Linux that launcher is a shell that `exec`s bwrap, so the fence's own
/// marker counts as well as the name.
fn is_fence(cmd: &str, env: &HashMap<String, String>) -> bool {
    env.contains_key(crate::app_env!("AGENT_FENCE"))
        || matches!(
            cmd.rsplit('/').next().unwrap_or(cmd),
            "bwrap" | "sandbox-exec"
        )
}

/// Run between a fenced command and the pane's trailing login shell: read and
/// discard whatever is waiting in the terminal's input queue (a CLI typed
/// into a shell tab gets the same from `agent_shim::run`). On a kernel that
/// still honours `TIOCSTI` (Linux before 6.2 or with `legacy_tiocsti=1`,
/// macOS), a fenced agent can push bytes into its own terminal's input and exit;
/// the next reader of that queue is the *unfenced* shell below, which would run
/// them. The fence's pid namespace dies with the agent, so nothing fenced can
/// add more after this runs. `min 0 time 0` makes `cat` see end-of-file the
/// moment the queue is empty; the saved modes are put back for the shell.
const FENCE_INPUT_DRAIN: &str = "s=$(stty -g 2>/dev/null); stty raw -echo min 0 time 0 2>/dev/null \
&& cat >/dev/null 2>&1; [ -n \"$s\" ] && stty \"$s\" 2>/dev/null; ";

/// What a command tab's pane runs once its command has exited: a login shell,
/// which keeps a finished run reattachable. After a fenced command it first
/// drains the terminal ([`FENCE_INPUT_DRAIN`]) and drops every [`SECRET_ENV`]
/// variable: the pane's `sh` holds the session environment, and the shell
/// left in the tab is **unfenced** — it must not inherit the agent's MCP
/// tokens, Copilot token or provider API keys. (`env -u` is in GNU and BSD
/// `env`.)
fn trailing_shell(fenced: bool) -> String {
    if !fenced {
        return "exec \"${SHELL:-/bin/bash}\" -l".to_string();
    }
    let unset: String = SECRET_ENV.iter().map(|k| format!("-u {k} ")).collect();
    format!("{FENCE_INPUT_DRAIN}exec env {unset}\"${{SHELL:-/bin/bash}}\" -l")
}

/// The inline `<cmd> <args>` half of a command tab's tmux target, with the
/// `export`s ahead of it when the tmux has no `new-session -e`. `None` for a
/// shell tab (no command). Everything is [`shell_quote`]d, so it is the same
/// text whether it lands on the tmux argv or in a [`launcher_script`].
fn command_line(
    target_cmd: &str,
    target_args: &[String],
    env: &HashMap<String, String>,
    session_env: bool,
) -> Option<String> {
    if target_cmd.is_empty() {
        return None;
    }
    let mut line = String::new();
    if !session_env {
        for (k, v) in session_env_pairs(env) {
            line.push_str(&format!("export {}={}; ", k, shell_quote(v)));
        }
    }
    line.push_str(&shell_quote(target_cmd));
    for a in target_args {
        line.push(' ');
        line.push_str(&shell_quote(a));
    }
    Some(line)
}

/// A `#!/bin/sh` script that `exec`s the command tab's command — the carrier
/// for a command line too long for the tmux argv (see [`TMUX_ARGV_LIMIT`]).
/// tmux then runs `'<script>'; exec "$SHELL" -l`, which is the inline shape
/// with the long part moved out; the script `exec`s so the command replaces
/// the script's shell exactly as it replaced nothing before. Pure: the caller
/// writes it (see [`wrap_pty_options_local`]).
pub(crate) fn launcher_script(
    target_cmd: &str,
    target_args: &[String],
    env: &HashMap<String, String>,
    session_env: bool,
) -> String {
    let mut script = String::from("#!/bin/sh\n");
    if !session_env {
        for (k, v) in session_env_pairs(env) {
            if SECRET_ENV.contains(&k) {
                continue; // carried on the tmux line instead, see `launcher_line`
            }
            script.push_str(&format!("export {k}={}\n", shell_quote(v)));
        }
    }
    // Exports are lines of their own above, so the command line itself is
    // rendered without them (`session_env = true`) and `exec`'d as one.
    let line = command_line(target_cmd, target_args, env, true).unwrap_or_default();
    script.push_str(&format!("exec {line}\n"));
    script
}

/// Env values that must never be written into a [`launcher_script`] nor onto
/// any argv: the script sits on disk for the session's lifetime (and past a
/// crash), the root console's MCP token is documented as never written to
/// disk, and `/proc/<pid>/cmdline` is readable by EVERY local user (0444, not
/// same-uid) — the tmux client that carries the argv stays attached for the
/// tab's whole life (#864).
pub(crate) const SECRET_ENV: &[&str] = &[
    crate::services::root_mcp::TOKEN_ENV,
    crate::services::root_mcp::SCHEDULE_TOKEN_ENV,
    crate::services::root_mcp::GIT_TOKEN_ENV,
    crate::services::root_mcp::HELP_TOKEN_ENV,
    crate::services::copilot_auth::TOKEN_ENV,
    // Appended, not inserted: each key keeps its `update-environment` slot.
    crate::services::root_mcp::MARKUP_TOKEN_ENV,
    // Provider API keys (`agent_api_keys::ENV_VARS`), slots 8636–8639. Like
    // every slot here they stay set on the user's default tmux server: a later
    // session there takes these variables from its client or drops them.
    crate::services::agent_api_keys::ANTHROPIC_ENV,
    crate::services::agent_api_keys::OPENAI_ENV,
    crate::services::agent_api_keys::GEMINI_ENV,
    crate::services::agent_api_keys::MISTRAL_ENV,
];

/// First `update-environment` array slot Tabtivity claims for [`SECRET_ENV`] (one
/// slot per key, fixed, so every tab re-sets the same entries instead of growing
/// the list). Far above tmux's defaults (0–8) and any hand-written list.
const SECRET_UPDATE_ENV_SLOT: usize = 8630;

/// The tmux command line that runs a launcher `path`. With `-e` the session env
/// carries every variable (the [`SECRET_ENV`] ones via `update-environment`, see
/// [`local_tmux_args_for`]); without it the script exports them, except the
/// [`SECRET_ENV`] ones, which ride on this line as an `env` prefix — never on
/// disk, and the line stays a few hundred bytes.
///
/// Known limit, on tmux < 3.2 only: this line (and the inline `export`s of
/// [`command_line`] when the argv is short enough to skip the script) is on the
/// tmux client's argv and is what tmux hands to `sh -c`, so for the tab's
/// lifetime the secrets are in those processes' argv — and `/proc/<pid>/cmdline`
/// is readable by every local user, not only this uid (#864). Keeping them off
/// the disk was the point; the ≥ 3.2 path keeps them off argv as well, by
/// letting tmux copy them from the client's *environment* (0400).
fn launcher_line(path: &str, env: &HashMap<String, String>, session_env: bool) -> String {
    let quoted = shell_quote(path);
    if session_env {
        return quoted;
    }
    let secrets: Vec<String> = session_env_pairs(env)
        .into_iter()
        .filter(|(k, _)| SECRET_ENV.contains(k))
        .map(|(k, v)| format!("{k}={}", shell_quote(v)))
        .collect();
    if secrets.is_empty() {
        quoted
    } else {
        format!("env {} {quoted}", secrets.join(" "))
    }
}

/// [`local_tmux_args_with`] with the command half already rendered: `line` is
/// what tmux runs before the trailing login shell, or `None` for a shell tab.
fn local_tmux_args_for(
    session: &str,
    line: Option<&str>,
    env: &HashMap<String, String>,
    session_env: bool,
    fenced: bool,
) -> Vec<String> {
    let pairs = session_env_pairs(env);
    let mut args: Vec<String> = vec![
        "set-option".into(),
        "-g".into(),
        "history-limit".into(),
        TMUX_HISTORY_LINES.to_string(),
        ";".into(),
    ];
    if session_env {
        // #864: a secret never rides `-e KEY=VALUE` — this client's argv is
        // world-readable for the tab's life. It is in the client's environment
        // instead (`build_command` puts `opts.env` there), and a key listed in the
        // global `update-environment` is copied from the creating (or attaching)
        // client's environment into the session's. A key the tab lacks is marked
        // removed, so a tab never inherits the token of the tab that started the
        // server. Fixed slots: idempotent, and the user's own entries are kept.
        for (i, key) in SECRET_ENV.iter().enumerate() {
            args.extend([
                "set-option".into(),
                "-g".into(),
                format!("update-environment[{}]", SECRET_UPDATE_ENV_SLOT + i),
                key.to_string(),
                ";".into(),
            ]);
        }
    }
    args.push("new-session".into());
    args.push("-A".into());
    if session_env {
        for (k, v) in pairs.iter().filter(|(k, _)| !SECRET_ENV.contains(k)) {
            args.push("-e".into());
            // One argv item, so no quoting: a value with spaces, quotes or `;`
            // reaches tmux exactly as written.
            args.push(format!("{k}={v}"));
        }
    }
    args.push("-s".into());
    args.push(session.to_string());
    if let Some(line) = line {
        // One positional arg = the command line tmux runs via `sh -c`. Keeping a
        // login shell after it is what makes a finished run reattachable.
        args.push(format!("{line}; {}", trailing_shell(fenced)));
    }
    // Session options as trailing tmux commands (standalone ';' tokens split argv).
    for tok in [
        ";",
        "set-option",
        "-t",
        session,
        "status",
        "off",
        ";",
        "set-option",
        "-t",
        session,
        "mouse",
        "on",
        ";",
        "set-window-option",
        "-t",
        session,
        "window-size",
        "largest",
        // A CLI that sees `$TMUX` wraps its OSC 52 copy in tmux's passthrough
        // (`ESC P tmux; …`), which tmux drops unless this is on — Mistral
        // Vibe's "copy this URL (press c)" then copied nothing. Passthrough
        // hands the pane's sequence to the pane's own xterm, where OSC 52 is
        // still focus-gated and sanitized (`decodeOsc52Clipboard`). A window
        // option on this session only: the tmux server is the user's own.
        // `-q`: a tmux older than 3.3 has no such option, and an error here
        // must not cut the chain short.
        ";",
        "set-window-option",
        "-q",
        "-t",
        session,
        "allow-passthrough",
        "on",
        // No prefix key on a Tabtivity session: nothing of Tabtivity's binds it,
        // and without one a phone's raw keystrokes reach the pane only, never
        // tmux's own command line (`docs/context/root_console.md`).
        ";",
        "set-option",
        "-t",
        session,
        "prefix",
        "None",
    ] {
        args.push(tok.to_string());
    }
    args
}

/// `tmux kill-session -t <session>` argv, for the explicit-close / Sessions-view
/// kill of a local persistent tab. `|| true` is unnecessary here (a missing
/// session just exits non-zero, which the fire-and-forget caller ignores).
pub fn local_tmux_kill_args(session: &str) -> Vec<String> {
    vec!["kill-session".into(), "-t".into(), session.to_string()]
}

/// `tmux capture-pane -p -t =<session>:` argv: the session's visible screen as
/// plain rows, for reading an agent's status line off the live pane. A hidden
/// desktop pane's xterm stops receiving output, so its buffer is a stale
/// screen; tmux always holds the current one. `=` makes the match exact — a
/// missing session fails instead of prefix-matching a sibling's.
pub fn local_tmux_screen_args(session: &str) -> Vec<String> {
    vec![
        "-u".into(),
        "capture-pane".into(),
        "-p".into(),
        "-t".into(),
        format!("={session}:"),
    ]
}

/// `tmux rename-session -t <old> <new>` argv.
pub fn local_tmux_rename_args(old: &str, new: &str) -> Vec<String> {
    vec![
        "rename-session".into(),
        "-t".into(),
        old.to_string(),
        new.to_string(),
    ]
}

/// `tmux ls -F …` argv for listing local sessions (same format the remote path
/// parses via `ssh_exec::parse_tmux_ls`).
pub fn local_tmux_ls_args() -> Vec<String> {
    vec![
        "ls".into(),
        "-F".into(),
        "#{session_name}\t#{session_windows}\t#{session_created}\t#{session_attached}\t#{session_activity}\t#{pane_current_command}\t#{pane_current_path}".into(),
    ]
}

/// Rewrite `opts` to spawn the tab inside a **local** tmux session when it carries
/// a `tmux_session` name and tmux is available. No-op otherwise (no name, or no
/// tmux — including all of Windows), leaving the tab to spawn exactly as before.
///
/// Only the resolved local command is rewritten. `cwd` is left for
/// `build_command` to apply to the `tmux` client, which a freshly-created session
/// does take its start directory from; `env` is **also** written into the session
/// explicitly, because that half is *not* inherited from the client (see
/// [`local_tmux_args`]). Callers must ensure this runs only for a **local** spawn
/// (not an `ssh`/`docker`-wrapped one) — see `commands::terminal::pty_spawn`, which
/// runs it last, after the session/fence rewrites have put their variables in
/// `opts.env`.
pub fn wrap_pty_options_local(opts: &mut PtyOptions) {
    if !tmux_available() {
        return;
    }
    let Some(session) = opts.tmux_session.clone() else {
        return;
    };
    let args = local_tmux_argv(&session, opts, false);
    opts.cmd = "tmux".to_string();
    opts.args = args;
}

/// The `tmux` argv that starts (or, with `-A`, re-attaches) `session` running
/// `opts`'s command: [`wrap_pty_options_local`]'s argv, and with `detached`
/// the same with `-d` right after `-A` — a session started by no terminal
/// (the Mobile sidecar's headless spawn, [`spawn_detached_with`]), which the
/// window later attaches to through the ordinary wrap. Past
/// [`TMUX_ARGV_BUDGET`] the command moves into a [`launcher_script`] either
/// way.
pub fn local_tmux_argv(session: &str, opts: &PtyOptions, detached: bool) -> Vec<String> {
    let session_env = tmux_supports_session_env();
    let mut args = local_tmux_args_with(session, &opts.cmd, &opts.args, &opts.env, session_env);
    if !opts.cmd.is_empty() && argv_bytes(&args) > TMUX_ARGV_BUDGET {
        // Past the client's message limit, tmux would exit with `command too
        // long` and the tab with `[process exited]`. Move the command into a
        // script and hand tmux its path instead.
        let script = launcher_script(&opts.cmd, &opts.args, &opts.env, session_env);
        match write_launcher(session, &script) {
            Ok(path) => {
                let line = launcher_line(&path.to_string_lossy(), &opts.env, session_env);
                args = local_tmux_args_for(
                    session,
                    Some(&line),
                    &opts.env,
                    session_env,
                    is_fence(&opts.cmd, &opts.env),
                );
            }
            Err(e) => {
                // Leave the long argv in place: tmux's own error is the honest
                // report, and the tab shows it.
                eprintln!("tmux_local: could not write launcher for '{session}': {e}");
            }
        }
    }
    if detached {
        detach(&mut args, opts.cols, opts.rows);
    }
    args
}

/// `-d` right after `new-session -A`: the session is created without
/// attaching the calling client. A no-op on an argv that already has it.
/// With no client, tmux gives the window its `default-size` (80×24), and the
/// phone adopts the window's geometry (`pty_bridge::window_size`) — so a
/// detached session also gets `-x cols -y rows`, or an agent's long footer
/// (Claude's status line with the model in it) is cut at 80 columns.
fn detach(args: &mut Vec<String>, cols: u16, rows: u16) {
    if let Some(at) = args.iter().position(|a| a == "-A") {
        if args.get(at + 1).map(String::as_str) != Some("-d") {
            args.insert(at + 1, "-d".into());
        }
        if cols > 0 && rows > 0 && !args.iter().any(|a| a == "-x") {
            let size = ["-x".to_string(), cols.to_string(), "-y".to_string(), rows.to_string()];
            args.splice(at + 2..at + 2, size);
        }
    }
}

/// Whether `opts` is already the tmux client's launch — what
/// [`wrap_pty_options_local`] (and so `launch_prep::prepare`) leaves behind:
/// `cmd` is `tmux` and the argv creates a session.
fn is_tmux_wrapped(opts: &PtyOptions) -> bool {
    opts.cmd == "tmux" && opts.args.iter().any(|a| a == "new-session")
}

/// The argv [`spawn_detached_with`] hands the tmux client for `session`.
/// A launch that `launch_prep::prepare` wrapped already carries the full
/// `new-session -A … '<fenced command>; exec "$SHELL" -l'` argv, so only
/// `-d` is added — wrapping it a second time put a `tmux new-session -A`
/// *inside* the session, which refused to nest ("unset $TMUX to force")
/// and left the pane on the trailing login shell instead of the agent. An
/// unwrapped launch is wrapped here, detached.
pub fn detached_argv(session: &str, opts: &PtyOptions) -> Vec<String> {
    if is_tmux_wrapped(opts) {
        let mut args = opts.args.clone();
        detach(&mut args, opts.cols, opts.rows);
        args
    } else {
        local_tmux_argv(session, opts, true)
    }
}

/// Start `opts`'s command in a **detached** local tmux session named by
/// `opts.tmux_session`, with no PTY and no window (headless owner plan, H1b:
/// the sidecar's spawn). The client gets what the PTY's `build_command` gives
/// one — the tab's `cwd`, `TERM`, `COLORTERM`, Tabtivity's PATH, then `opts.env`
/// — so the session's environment is what an attached spawn's would be; the
/// per-tab secrets reach the session through the client environment and
/// `update-environment`, never the argv (#864). `socket` names a private tmux
/// server (`-L`), for tests only: production passes `None` and shares the
/// default server with the window's spawns. `opts` must already be prepared
/// (`launch_prep::prepare`), which tmux-wraps it; the argv is then used as
/// is plus `-d` ([`detached_argv`]), never wrapped a second time.
#[cfg(unix)]
pub fn spawn_detached_with(opts: &PtyOptions, socket: Option<&str>) -> Result<(), String> {
    let Some(session) = opts.tmux_session.as_deref() else {
        return Err(format!("terminal: tab '{}' has no tmux session to start", opts.id));
    };
    if !tmux_available() {
        return Err("terminal: tmux is not installed".to_string());
    }
    let args = detached_argv(session, opts);
    let mut cmd = crate::paths::command_no_window("tmux");
    if let Some(socket) = socket {
        cmd.args(["-L", socket, "-f", "/dev/null"]);
    }
    cmd.args(&args);
    if !opts.cwd.is_empty() {
        cmd.current_dir(&opts.cwd);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if let Some(path) = crate::paths::effective_path() {
        cmd.env("PATH", path);
    }
    for (k, v) in &opts.env {
        cmd.env(k, v);
    }
    cmd.stdin(std::process::Stdio::null());
    let out = cmd
        .output()
        .map_err(|e| format!("terminal: could not run tmux for '{session}': {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(format!("terminal: tmux refused to start '{session}': {err}"))
    }
}

/// Where a session's [`launcher_script`] lives:
/// `<state_dir>/tmux-launch/<session>.sh`. Keyed by the session name so a
/// respawn of the same tab overwrites its own script, and sanitized like the
/// other state-dir keys so a session name never becomes a path.
fn launcher_path(session: &str) -> std::path::PathBuf {
    crate::storage::state_dir()
        .join("tmux-launch")
        .join(format!("{}.sh", crate::storage::project_key(session)))
}

/// Write `script` as the session's launcher, executable by its owner only.
fn write_launcher(session: &str, script: &str) -> std::io::Result<std::path::PathBuf> {
    let path = launcher_path(session);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&path, script)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(path)
}

/// Drop a session's launcher once the session is gone. The script only
/// matters while `new-session -A` might still *create* the session; a
/// respawn writes a fresh one, so nothing is lost by removing it early.
pub fn remove_launcher(session: &str) {
    let _ = std::fs::remove_file(launcher_path(session));
}

#[cfg(test)]
mod tests {
    use crate::brand::SLUG;
    use super::*;

    fn env_of(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn shell_tab_uses_default_login_shell_and_options() {
        // No target command → bare new-session (tmux's default login shell) so the
        // shell survives a typed command's completion; options chained after `;`.
        let args = local_tmux_args_with(concat!(crate::app_slug!(), "-abc"), "", &[], &HashMap::new(), false);
        assert_eq!(
            args,
            vec![
                // history-limit precedes new-session: a pane copies it at
                // creation, so the trailing `-t`-scoped sets are too late.
                "set-option",
                "-g",
                "history-limit",
                "10000",
                ";",
                "new-session",
                "-A",
                "-s",
                concat!(crate::app_slug!(), "-abc"),
                ";",
                "set-option",
                "-t",
                concat!(crate::app_slug!(), "-abc"),
                "status",
                "off",
                ";",
                "set-option",
                "-t",
                concat!(crate::app_slug!(), "-abc"),
                "mouse",
                "on",
                ";",
                "set-window-option",
                "-t",
                concat!(crate::app_slug!(), "-abc"),
                "window-size",
                "largest",
                ";",
                "set-window-option",
                "-q",
                "-t",
                concat!(crate::app_slug!(), "-abc"),
                "allow-passthrough",
                "on",
                ";",
                "set-option",
                "-t",
                concat!(crate::app_slug!(), "-abc"),
                "prefix",
                "None",
            ]
        );
    }

    #[test]
    fn command_tab_runs_command_then_keeps_a_shell() {
        // A command tab keeps a login shell AFTER the command so the finished run
        // reattaches (resumable-command-tab guarantee) instead of re-running.
        let args =
            local_tmux_args_with(concat!(crate::app_slug!(), "-x"), "python", &["train.py".into()], &HashMap::new(), true);
        let new_session = args.iter().position(|a| a == "new-session").unwrap();
        assert_eq!(args[new_session - 1], ";");
        assert!(args.iter().any(|a| a == concat!(crate::app_slug!(), "-x")));
        let target = &args[new_session + 4];
        assert_eq!(
            target,
            "'python' 'train.py'; exec \"${SHELL:-/bin/bash}\" -l"
        );
        // Options still trail.
        assert!(args
            .windows(2)
            .any(|w| w == [";".to_string(), "set-option".to_string()]));
    }

    #[test]
    fn tab_env_reaches_the_session_as_new_session_flags() {
        // The pane does not inherit the client's environment (tmux copies the
        // SERVER's), so the tab's own variables ride on `new-session -e` — sorted,
        // one argv item each, before `-s`.
        let env = env_of(&[
            (crate::app_env!("TAB_UID"), "tab-uid-1"),
            ("ANTHROPIC_MODEL", "opus"),
            // A provider API key is a secret (`SECRET_ENV`): never on `-e`.
            // "sk-test" rather than a bare letter: `scripts/privacy-check.sh`
            // clears an api_key whose value is built out of placeholder words, and
            // reports every other one — a fixture must not need the override.
            ("ANTHROPIC_API_KEY", "sk-test"),
            // tmux owns TERM per pane; a bad key would land unquoted in `export`.
            ("TERM", "xterm-256color"),
            ("not a key", "x"),
        ]);
        let args = local_tmux_args_with(concat!(crate::app_slug!(), "-x"), "claude", &[], &env, true);
        let e: Vec<&str> = args
            .windows(2)
            .filter(|w| w[0] == "-e")
            .map(|w| w[1].as_str())
            .collect();
        assert_eq!(e, vec!["ANTHROPIC_MODEL=opus", concat!(crate::app_upper!(), "_TAB_UID=tab-uid-1")]);
        // …and the flags precede the session name, as tmux requires.
        let dash_s = args.iter().position(|a| a == "-s").unwrap();
        assert!(args.iter().position(|a| a == "-e").unwrap() < dash_s);
        assert_eq!(args[dash_s + 1], concat!(crate::app_slug!(), "-x"));
    }

    #[test]
    fn without_session_env_support_a_command_tab_exports_inline() {
        // tmux < 3.2 has no `-e`; an agent tab still gets its key by exporting it
        // at the head of the command line tmux runs.
        // `_Q` sorts after the app's variable whatever the app is called.
        let env = env_of(&[(crate::app_env!("TAB_UID"), "tab-uid-1"), ("_Q", "a'b c")]);
        let args = local_tmux_args_with(concat!(crate::app_slug!(), "-x"), "claude", &[], &env, false);
        assert!(!args.iter().any(|a| a == "-e"));
        assert_eq!(
            args[9],
            concat!("export ", crate::app_upper!(), "_TAB_UID='tab-uid-1'; export _Q='a'\\''b c'; \
             'claude'; exec \"${SHELL:-/bin/bash}\" -l")
        );
    }

    #[test]
    fn launcher_script_execs_the_same_quoted_line() {
        // The script carries exactly the text the inline form would have put on
        // the tmux argv — exports first when the tmux lacks `-e`, then the
        // quoted command — behind `exec`, so the command replaces the script's
        // shell the way it replaced nothing inline.
        let env = env_of(&[(crate::app_env!("TAB_UID"), "tab-uid-1")]);
        let args = vec!["--bind".to_string(), "/a b".to_string(), "it's".to_string()];
        assert_eq!(
            launcher_script("bwrap", &args, &env, true),
            "#!/bin/sh\nexec 'bwrap' '--bind' '/a b' 'it'\\''s'\n"
        );
        assert_eq!(
            launcher_script("bwrap", &args, &env, false),
            concat!("#!/bin/sh\nexport ", crate::app_upper!(), "_TAB_UID='tab-uid-1'\nexec 'bwrap' '--bind' '/a b' 'it'\\''s'\n")
        );
    }

    #[test]
    fn only_a_fenced_command_drains_input_before_the_unfenced_shell() {
        let env = env_of(&[]);
        let shell = "exec \"${SHELL:-/bin/bash}\" -l";
        for fence in ["bwrap", "/usr/bin/sandbox-exec"] {
            let args = local_tmux_args_with(concat!(crate::app_slug!(), "-x"), fence, &["claude".into()], &env, true);
            let line = args.iter().find(|a| a.ends_with("\"${SHELL:-/bin/bash}\" -l")).unwrap();
            assert!(line.contains(&format!("; {FENCE_INPUT_DRAIN}exec env -u ")), "{line}");
        }
        let args = local_tmux_args_with(concat!(crate::app_slug!(), "-x"), "claude", &[], &env, true);
        assert!(args.iter().any(|a| a == &format!("'claude'; {shell}")));
        // A shell tab has no command line and so no trailing shell to guard.
        let args = local_tmux_args_with(concat!(crate::app_slug!(), "-x"), "", &[], &env, true);
        assert!(!args.iter().any(|a| a.contains("stty")));
    }

    #[test]
    fn the_unfenced_shell_after_a_fenced_command_inherits_no_secret() {
        // The pane's `sh` holds the session environment — tokens and API keys
        // included — and the login shell it execs after the agent is unfenced.
        let tail = trailing_shell(true);
        assert!(tail.starts_with(FENCE_INPUT_DRAIN), "{tail}");
        assert!(tail.ends_with("\"${SHELL:-/bin/bash}\" -l"), "{tail}");
        for key in SECRET_ENV {
            assert!(tail.contains(&format!("-u {key} ")), "{key}: {tail}");
        }
        assert!(tail.contains(&format!("-u {} ", crate::services::agent_api_keys::ANTHROPIC_ENV)));
        // Through the launcher form too.
        let env = env_of(&[]);
        let launched = local_tmux_args_for(concat!(crate::app_slug!(), "-x"), Some("'/l.sh'"), &env, true, true);
        assert!(launched.iter().any(|a| a == &format!("'/l.sh'; {tail}")), "{launched:?}");
        // An unfenced command's shell is the user's own, unchanged.
        assert_eq!(trailing_shell(false), "exec \"${SHELL:-/bin/bash}\" -l");
        // `sh` really runs it: the secret is gone, the rest is kept.
        #[cfg(unix)]
        {
            let probe = format!(
                "exec env -u {} sh -c 'printf \"%s|%s\" \"${{{}-unset}}\" \"$KEEP\"'",
                crate::services::agent_api_keys::ANTHROPIC_ENV,
                crate::services::agent_api_keys::ANTHROPIC_ENV,
            );
            let out = std::process::Command::new("sh")
                .args(["-c", &probe])
                .env(crate::services::agent_api_keys::ANTHROPIC_ENV, "sk-test-fake")
                .env("KEEP", "kept")
                .output()
                .unwrap();
            assert_eq!(String::from_utf8_lossy(&out.stdout), "unset|kept");
        }
    }

    #[test]
    fn the_root_mcp_token_never_reaches_the_launcher_script() {
        // A fenced root agent's argv always takes the launcher path, and the
        // script outlives a crash on disk — the token rides on tmux's argv.
        let env = env_of(&[
            (crate::app_env!("TAB_UID"), "tab-uid-1"),
            (crate::services::root_mcp::TOKEN_ENV, "s3cret"),
        ]);
        for session_env in [true, false] {
            let script = launcher_script("claude", &[], &env, session_env);
            assert!(!script.contains("s3cret"), "{script}");
        }
        assert_eq!(launcher_line("/l.sh", &env, true), "'/l.sh'");
        assert_eq!(
            launcher_line("/l.sh", &env, false),
            concat!("env ", crate::app_upper!(), "_ROOT_MCP_TOKEN='s3cret' '/l.sh'")
        );
        assert_eq!(launcher_line("/l.sh", &env_of(&[("A", "b")]), false), "'/l.sh'");
    }

    #[test]
    fn a_fence_sized_argv_is_over_budget_and_the_launcher_form_is_not() {
        // A fenced agent on a well-used machine: one `--ro-bind src dst` per
        // transcript dir, and 120 of those already pass tmux's message
        // limit — which is `command too long` and a dead tab. The launcher
        // form of the same tab is a few hundred bytes regardless.
        let mut fence: Vec<String> = Vec::new();
        for i in 0..120 {
            let p = format!("/home/user/.claude/projects/-home-user-{SLUG}-projects-project-{i:03}");
            fence.extend(["--ro-bind".to_string(), p.clone(), p]);
        }
        fence.extend(["--".to_string(), "claude".to_string()]);
        let env = env_of(&[(crate::app_env!("TAB_UID"), "tab-uid-1")]);
        let inline = local_tmux_args_with(concat!(crate::app_slug!(), "-x"), "bwrap", &fence, &env, true);
        assert!(argv_bytes(&inline) > TMUX_ARGV_LIMIT, "{}", argv_bytes(&inline));

        let line = shell_quote(concat!("/state/tmux-launch/", crate::app_slug!(), "-x.sh"));
        let launched = local_tmux_args_for(concat!(crate::app_slug!(), "-x"), Some(&line), &env, true, true);
        assert!(argv_bytes(&launched) < TMUX_ARGV_BUDGET);
        let dash_s = launched.iter().position(|a| a == "-s").unwrap();
        assert_eq!(
            launched[dash_s + 2],
            format!("'/state/tmux-launch/{SLUG}-x.sh'; {}", trailing_shell(true))
        );
        // The env still rides `-e`; only the command moved.
        assert!(launched.iter().any(|a| a == concat!(crate::app_upper!(), "_TAB_UID=tab-uid-1")));
        // A shell tab has no command line to move, launcher or not.
        assert!(command_line("", &[], &env, true).is_none());
    }

    #[test]
    fn no_argv_item_carries_a_secret_value() {
        // #864: `/proc/<pid>/cmdline` is world-readable and the tmux client stays
        // attached, so a token VALUE must be on no argv item — inline, launcher,
        // or either tmux generation's fallback that does not need the export.
        let env = env_of(&[
            (crate::app_env!("TAB_UID"), "tab-uid-1"),
            (crate::services::root_mcp::TOKEN_ENV, "root-s3cret"),
            (crate::services::root_mcp::SCHEDULE_TOKEN_ENV, "sched-s3cret"),
            (crate::services::root_mcp::HELP_TOKEN_ENV, "help-s3cret"),
            (crate::services::root_mcp::MARKUP_TOKEN_ENV, "markup-s3cret"),
            (crate::services::copilot_auth::TOKEN_ENV, "gho_copilot-s3cret"),
            (crate::services::agent_api_keys::ANTHROPIC_ENV, "sk-test-anthropic-s3cret"),
        ]);
        let leaks = |args: &[String]| args.iter().any(|a| a.contains("s3cret"));
        // The API key is listed: it never rides `-e`, and the script skips it.
        assert!(SECRET_ENV.contains(&crate::services::agent_api_keys::ANTHROPIC_ENV));
        for session_env in [true, false] {
            let script = launcher_script("bwrap", &["--x".into()], &env, session_env);
            assert!(!script.contains("s3cret"), "{script}");
        }
        for cmd in ["", "claude", "bwrap"] {
            let args = local_tmux_args_with(concat!(crate::app_slug!(), "-x"), cmd, &["--x".into()], &env, true);
            assert!(!leaks(&args), "{args:?}");
            // The non-secret variable still rides `-e`.
            assert!(args.iter().any(|a| a == concat!(crate::app_upper!(), "_TAB_UID=tab-uid-1")), "{args:?}");
        }
        let line = launcher_line("/l.sh", &env, true);
        let launched = local_tmux_args_for(concat!(crate::app_slug!(), "-x"), Some(&line), &env, true, true);
        assert!(!leaks(&launched), "{launched:?}");
        // Instead every secret key is listed in `update-environment`, ahead of
        // `new-session`, so tmux copies it from the client's environment.
        let args = local_tmux_args_with(concat!(crate::app_slug!(), "-x"), "claude", &[], &env, true);
        let new_session = args.iter().position(|a| a == "new-session").unwrap();
        for (i, key) in SECRET_ENV.iter().enumerate() {
            let slot = format!("update-environment[{}]", SECRET_UPDATE_ENV_SLOT + i);
            let at = args.iter().position(|a| *a == slot).unwrap();
            assert!(at < new_session);
            assert_eq!(args[at - 2..at + 3], ["set-option", "-g", &slot, key, ";"]);
        }
        // A tab without tokens clears them too (no inheriting the founding tab's).
        let plain = local_tmux_args_with(concat!(crate::app_slug!(), "-x"), "", &[], &env_of(&[]), true);
        assert!(plain.iter().any(|a| a == &format!("update-environment[{SECRET_UPDATE_ENV_SLOT}]")));
        // The < 3.2 fallback has no update-environment step (unchanged shape).
        let old = local_tmux_args_with(concat!(crate::app_slug!(), "-x"), "", &[], &env, false);
        assert!(!old.iter().any(|a| a.starts_with("update-environment")));
    }

    /// Live check against a real tmux on a private socket (skipped when tmux is
    /// missing or older than 3.2): the pane gets the token from the client's
    /// environment, and the token is on no argv of the client.
    #[cfg(unix)]
    #[test]
    fn a_real_tmux_session_gets_the_secret_from_the_client_environment() {
        let Ok(v) = std::process::Command::new("tmux").arg("-V").output() else {
            return;
        };
        if !v.status.success() || !version_supports_session_env(&String::from_utf8_lossy(&v.stdout)) {
            return;
        }
        let socket = format!(concat!(crate::app_slug!(), "-test-864-{}"), std::process::id());
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("env.txt");
        let token_env = crate::services::root_mcp::TOKEN_ENV;
        let tmux = |args: &[String], env: &[(&str, &str)]| {
            let mut cmd = std::process::Command::new("tmux");
            cmd.args(["-L", &socket, "-f", "/dev/null"]).args(args).env_remove(token_env);
            for (k, val) in env {
                cmd.env(k, val);
            }
            cmd.output().unwrap()
        };
        // A founding session whose client carries a DIFFERENT token: it becomes
        // the server's global environment, which the second tab must not see.
        let founder = vec!["new-session".to_string(), "-d".into(), "-s".into(), "founder".into(), "sleep 30".into()];
        assert!(tmux(&founder, &[(token_env, "founder-token")]).status.success());

        let env = env_of(&[(token_env, "tab-token-value"), (crate::app_env!("TAB_UID"), "u1")]);
        let script = format!("env > '{}'", out.display());
        let mut args = local_tmux_args_with(concat!(crate::app_slug!(), "-t"), "sh", &["-c".into(), script], &env, true);
        assert!(!args.iter().any(|a| a.contains("tab-token-value")), "{args:?}");
        // Detached: a test has no terminal to attach to.
        let at = args.iter().position(|a| a == "-A").unwrap();
        args.insert(at + 1, "-d".into());
        let created = tmux(&args, &[(token_env, "tab-token-value")]);
        assert!(created.status.success(), "{}", String::from_utf8_lossy(&created.stderr));
        let mut seen = String::new();
        for _ in 0..50 {
            seen = std::fs::read_to_string(&out).unwrap_or_default();
            if seen.contains(crate::app_env!("TAB_UID")) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let _ = tmux(&["kill-server".to_string()], &[]);
        assert!(seen.contains(&format!("{token_env}=tab-token-value")), "{seen}");
        assert!(seen.contains(concat!(crate::app_upper!(), "_TAB_UID=u1")), "{seen}");
        assert!(!seen.contains("founder-token"), "{seen}");
    }

    #[test]
    fn launcher_path_cannot_leave_the_launch_dir() {
        let path = launcher_path("../../etc/x y");
        assert_eq!(path.file_name().unwrap().to_str().unwrap(), "______etc_x_y.sh");
        assert!(path.parent().unwrap().ends_with("tmux-launch"));
    }

    #[test]
    fn session_env_floor_is_tmux_3_2() {
        assert!(version_supports_session_env("tmux 3.2\n"));
        assert!(version_supports_session_env("tmux 3.2a\n"));
        assert!(version_supports_session_env("tmux 3.6\n"));
        assert!(version_supports_session_env("tmux 4.0\n"));
        assert!(version_supports_session_env("tmux next-3.4\n"));
        assert!(version_supports_session_env("tmux master\n"));
        assert!(!version_supports_session_env("tmux 3.1c\n"));
        assert!(!version_supports_session_env("tmux 2.7\n"));
        // Unparseable → no flag: an unknown `-e` would kill every persistent tab.
        assert!(!version_supports_session_env(""));
        assert!(!version_supports_session_env("something else"));
    }

    #[test]
    fn kill_and_rename_argv() {
        assert_eq!(local_tmux_kill_args("s"), vec!["kill-session", "-t", "s"]);
        assert_eq!(
            local_tmux_screen_args(concat!(crate::app_slug!(), "-s")),
            vec!["-u", "capture-pane", "-p", "-t", concat!("=", crate::app_slug!(), "-s:")]
        );
        assert_eq!(
            local_tmux_rename_args("old", "new"),
            vec!["rename-session", "-t", "old", "new"]
        );
    }

    #[test]
    fn identifies_only_app_owned_sessions() {
        assert!(is_app_local_tmux_session(concat!(crate::app_slug!(), "-project--shell-123")));
        assert!(!is_app_local_tmux_session("train"));
        assert!(!is_app_local_tmux_session(concat!("my-", crate::app_slug!(), "-run")));
    }

    #[test]
    fn quit_reaps_every_app_session_and_no_foreign_one() {
        // A user's own `train`/`work` sessions are never touched; every Tabtivity-
        // minted one goes.
        let listed = [
            "train",
            concat!(crate::app_slug!(), "-p1--shell-1"),
            concat!(crate::app_slug!(), "-p2--agent-abc"),
            "work",
            concat!("my-", crate::app_slug!(), "-run"),
        ];
        assert_eq!(
            sessions_to_reap(listed),
            vec![concat!(crate::app_slug!(), "-p1--shell-1").to_string(), concat!(crate::app_slug!(), "-p2--agent-abc").to_string()]
        );
        assert!(sessions_to_reap(["train"]).is_empty());
    }

    #[test]
    fn already_gone_failures_are_not_errors() {
        assert!(kill_failure_is_already_gone(concat!("can't find session: ", crate::app_slug!(), "-x")));
        assert!(kill_failure_is_already_gone("no server running on /tmp/tmux-1000/default"));
        assert!(kill_failure_is_already_gone("error connecting to /tmp/tmux-1000/default (failed to connect to server)"));
        assert!(kill_failure_is_already_gone("server exited unexpectedly"));
        assert!(!kill_failure_is_already_gone("permission denied"));
        assert!(!kill_failure_is_already_gone(""));
    }

    #[test]
    fn wrap_no_session_is_noop() {
        let mut opts = PtyOptions {
            id: "t".into(),
            cmd: "bash".into(),
            args: vec![],
            env: Default::default(),
            cwd: "/p".into(),
            cols: 80,
            rows: 24,
            local_only: false,
            sandbox: false,
            agent: false,
            project_id: Some("p".into()),
            remote_host_id: None,
            tmux_session: None,
            tmux_attach: None,
            host_bound_uid: None,
            schedule_target_id: None,
            host_session: false,
        };
        wrap_pty_options_local(&mut opts);
        assert_eq!(opts.cmd, "bash");
    }

    fn detached_fixture(session: &str, cwd: &str) -> PtyOptions {
        PtyOptions {
            id: format!("headless:{session}"),
            cmd: "sleep".into(),
            args: vec!["30".into()],
            env: env_of(&[(crate::app_env!("TAB_UID"), "u-detached")]),
            cwd: cwd.into(),
            cols: 80,
            rows: 24,
            local_only: false,
            sandbox: false,
            agent: false,
            project_id: Some("p".into()),
            remote_host_id: None,
            tmux_session: Some(session.into()),
            tmux_attach: None,
            host_bound_uid: None,
            schedule_target_id: None,
            host_session: false,
        }
    }

    #[test]
    fn the_detached_argv_is_the_attached_one_plus_d() {
        let opts = detached_fixture(concat!(crate::app_slug!(), "-p--shell-x"), "/p");
        let attached = local_tmux_argv(concat!(crate::app_slug!(), "-p--shell-x"), &opts, false);
        let detached = local_tmux_argv(concat!(crate::app_slug!(), "-p--shell-x"), &opts, true);
        let at = attached.iter().position(|a| a == "-A").unwrap();
        let mut expected = attached.clone();
        expected.insert(at + 1, "-d".into());
        expected.splice(at + 2..at + 2, ["-x", "80", "-y", "24"].map(String::from));
        assert_eq!(detached, expected);
        assert!(!attached.contains(&"-d".to_string()));
    }

    /// The headless spawn runs what `launch_prep::prepare` hands it, and
    /// `prepare` has already tmux-wrapped the fenced agent. The detached argv
    /// must be that one wrapping plus `-d`: one `new-session`, the agent as
    /// the session's command, no `tmux` inside the session — a second wrap
    /// nested a tmux client that refused ("unset $TMUX to force") and left
    /// the pane on the trailing login shell.
    #[test]
    fn a_prepared_launch_is_detached_without_a_nested_tmux() {
        let session = concat!(crate::app_slug!(), "-p--agent-x");
        let mut opts = detached_fixture(session, "/p");
        opts.cmd = "claude".into();
        opts.args = vec!["--session-id".into(), "u1".into()];
        opts.env.insert(crate::app_env!("AGENT_FENCE").into(), "1".into());
        // What `wrap_pty_options_local` leaves behind (`prepare`'s last step).
        let wrapped = local_tmux_args_with(session, &opts.cmd, &opts.args, &opts.env, true);
        opts.args = wrapped.clone();
        opts.cmd = "tmux".into();

        let args = detached_argv(session, &opts);
        let mut expected = wrapped;
        detach(&mut expected, opts.cols, opts.rows);
        assert_eq!(args, expected);
        assert_eq!(args.iter().filter(|a| *a == "new-session").count(), 1, "{args:?}");
        let at = args.iter().position(|a| a == "-A").unwrap();
        assert_eq!(args[at + 1], "-d");
        // Sized by the launch, not tmux's 80×24 default the phone would adopt.
        assert_eq!(args[at + 2..at + 6], ["-x", "80", "-y", "24"]);
        let name = args.iter().position(|a| a == "-s").unwrap();
        assert_eq!(args[name + 1], session);
        let line = &args[name + 2];
        assert!(line.starts_with("'claude' '--session-id' 'u1'; "), "{line}");
        assert!(line.ends_with(&trailing_shell(true)), "{line}");
        assert!(!args.iter().any(|a| a.contains("tmux")), "nested tmux: {args:?}");
        // Wrapping the prepared launch again is the bug this guards against.
        let twice = local_tmux_argv(session, &opts, true);
        assert!(twice.iter().any(|a| a.contains("'tmux'")), "{twice:?}");
    }

    #[cfg(unix)]
    #[test]
    fn a_spawn_without_a_session_name_is_refused() {
        let mut opts = detached_fixture(concat!(crate::app_slug!(), "-p--shell-x"), "/p");
        opts.tmux_session = None;
        assert!(spawn_detached_with(&opts, Some(concat!(crate::app_slug!(), "-test-unused"))).is_err());
    }

    /// Live check on a private socket (skipped without tmux): the headless
    /// spawn creates a session the server finds, with the tab's environment
    /// inside it, and nothing attached.
    #[cfg(unix)]
    #[test]
    fn a_detached_spawn_creates_a_session_the_server_finds() {
        if !tmux_available() {
            return;
        }
        let socket = format!(concat!(crate::app_slug!(), "-test-h1b-{}"), std::process::id());
        let session = concat!(crate::app_slug!(), "-p--shell-detached");
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("env.txt");
        let mut opts = detached_fixture(session, &dir.path().to_string_lossy());
        opts.cmd = "sh".into();
        opts.args = vec!["-c".into(), format!("env > '{}'; sleep 30", out.display())];
        let tmux = |args: &[&str]| {
            std::process::Command::new("tmux")
                .args(["-L", &socket, "-f", "/dev/null"])
                .args(args)
                .output()
                .unwrap()
        };
        let spawned = spawn_detached_with(&opts, Some(&socket));
        let has = tmux(&["has-session", "-t", &format!("={session}")]);
        let listed = tmux(&["ls", "-F", "#{session_name}\t#{session_attached}"]);
        let mut seen = String::new();
        for _ in 0..50 {
            seen = std::fs::read_to_string(&out).unwrap_or_default();
            if seen.contains(crate::app_env!("TAB_UID")) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let _ = tmux(&["kill-server"]);
        spawned.unwrap();
        assert!(has.status.success(), "{}", String::from_utf8_lossy(&has.stderr));
        let listed = String::from_utf8_lossy(&listed.stdout).into_owned();
        assert!(listed.lines().any(|l| l == format!("{session}\t0")), "{listed}");
        assert!(seen.contains(concat!(crate::app_env!("TAB_UID"), "=u-detached")), "{seen}");
    }
}

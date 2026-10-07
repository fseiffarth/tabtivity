//! Remote (SSH) command execution for terminal/agent tabs.
//!
//! Remote projects are SSH/SFTP-native (no local FUSE mount): the user's scripts
//! and agents run **on the remote host**. This module rewrites a tab's
//! `PtyOptions` so that instead of spawning the requested command directly, the
//! PTY spawns the local `ssh` client with a forced TTY (`-tt`). The ssh client
//! allocates a remote PTY, so resize/kill/exit keep working through the local PTY
//! unchanged.
//!
//! Remoteness is **explicit**: the frontend tags a project-scope spawn with the
//! owning `project_id` in `PtyOptions`, and `wrap_pty_options` resolves its
//! `RemoteSpec` via `services::remote::remote_target_for` (a `RemoteTarget`).
//! The remote working dir is the project root (`spec.remote_path`). Local
//! projects (and tabs flagged `local_only`, e.g. local Ollama agents, and
//! untagged root/connection terminals) are left untouched.
//!
//! As elsewhere, `host`/`user`/`remote_path` are validated (no leading `-`, no
//! control characters) and passed to `ssh` as separate argv items. The one
//! unavoidable shell string is the *remote* command — ssh always concatenates
//! its trailing argv and hands it to the remote `$SHELL -c` — so each token is
//! single-quoted via `shell_quote` before it is embedded.

use crate::brand::SLUG;
use std::collections::HashMap;
use std::path::PathBuf;

use crate::schema::project::RemoteSpec;
use crate::services::remote_agents;
use crate::services::ssh_common::{ssh_base_args, ssh_target, validate_arg};
use crate::storage;
use crate::terminal::PtyOptions;

/// `sshfs`-style keepalive so a flaky link recovers instead of wedging. Unlike
/// the mount/check paths we deliberately do **not** set `BatchMode=yes`: the PTY
/// is interactive, so a first-connection passphrase or host-key prompt can be
/// answered by the user inside the terminal.
const SSH_KEEPALIVE: &[&str] = &[
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
];

/// How long the multiplexing master stays alive after the last session closes.
/// Multiplexing is Unix-only (see [`ssh_pty_args`]), so this is unused on Windows.
#[cfg(not(target_os = "windows"))]
const CONTROL_PERSIST_SECS: u32 = 600;

/// Agent-auth environment variables that must **not** be forwarded to the
/// remote. A remote agent authenticates with its own stored login (e.g.
/// `~/.claude`); a forwarded local key/token would silently clobber that
/// session (most CLIs prefer an env key over stored credentials). These are
/// dropped from the exported env alongside `TERM`/`COLORTERM`.
pub(crate) const AGENT_AUTH_ENV: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
];

/// Directory holding ssh ControlMaster sockets, created on demand.
/// `<state_dir>/ssh-control` (e.g. `~/.local/share/tabtivity/ssh-control`). The
/// single shared `cm-%C` master socket here is reused by every remote path —
/// agent tabs, the pooled SFTP session (`services::remote`/`services::sftp`),
/// git-over-ssh, and an interactive login — so authentication happens once.
///
/// Where that path is too long for a socket (see [`pick_control_dir`]) it is
/// `$XDG_RUNTIME_DIR/tabtivity-ssh` instead, created here: the runtime dir is
/// emptied at every login, and not every master spawn creates the dir first.
/// Fenced agent tabs see neither (`agent_fence` mounts a tmpfs over `/run` and
/// replaces `$HOME`), so the move hands them no master.
pub(crate) fn control_dir() -> PathBuf {
    let runtime = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .filter(|p| p.is_dir());
    let dir = pick_control_dir(runtime.as_deref(), &storage::state_dir());
    #[cfg(unix)]
    if runtime.as_deref().is_some_and(|rt| dir.starts_with(rt)) && !dir.is_dir() {
        use std::os::unix::fs::DirBuilderExt;
        let _ = std::fs::DirBuilder::new().mode(0o700).create(&dir);
    }
    dir
}

/// The longest path `bind(2)` accepts for a Unix socket: `sun_path` holds 108
/// bytes on Linux and 104 on macOS/BSD, the terminating NUL included.
const SOCKET_PATH_MAX: usize = if cfg!(target_os = "linux") { 107 } else { 103 };

/// What a master adds to the control dir: `/cm-` and the 40 hex digits of `%C`,
/// and OpenSSH first binds the socket under a temporary `.<16 random chars>`
/// name beside it. When that bind fails the master exits after logging in, so a
/// project's connection fails while a plain `ssh` to the same host works.
const CONTROL_SOCKET_SUFFIX: usize = "/cm-".len() + 40 + ".".len() + 16;

/// `<state_dir>/ssh-control` where the master's socket fits under it, else
/// `<runtime>/tabtivity-ssh`. The rename made the state dir three bytes longer, which
/// pushed `/home/<user>/.local/share/<slug>/ssh-control` past the limit for
/// any user name over five letters (over eight before).
fn pick_control_dir(runtime: Option<&std::path::Path>, state_dir: &std::path::Path) -> PathBuf {
    let fits = |dir: &std::path::Path| dir.as_os_str().len() + CONTROL_SOCKET_SUFFIX <= SOCKET_PATH_MAX;
    let in_state = state_dir.join("ssh-control");
    if fits(&in_state) {
        return in_state;
    }
    match runtime.filter(|rt| rt.is_absolute()) {
        Some(rt) if fits(&rt.join(concat!(crate::app_slug!(), "-ssh"))) => {
            rt.join(concat!(crate::app_slug!(), "-ssh"))
        }
        _ => in_state,
    }
}

/// The socket path `cm-%C` actually expands to for this target.
///
/// `%C` is a hash of (local host, remote host, port, user) that OpenSSH computes
/// and we cannot, so it is *asked*: `ssh -G` prints the effective config with the
/// token already expanded, and connects to nothing while doing it. Needed by
/// anything that must touch the socket as a file — [`sweep_stale_control_sockets`]
/// and `services::remote`'s teardown, which unlinks it.
///
/// `None` on Windows (no control socket at all) and whenever `ssh -G` cannot be
/// run or says nothing — callers treat that as "no socket to manage", never as a
/// path to guess at.
pub fn resolve_control_path(spec: &RemoteSpec) -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let _ = spec;
        None
    }
    #[cfg(not(target_os = "windows"))]
    {
        let target = ssh_target(&spec.user, &spec.host).ok()?;
        let template = control_dir().join("cm-%C");
        let mut cmd = crate::paths::command_no_window("ssh");
        cmd.arg("-G")
            .arg("-o")
            .arg(format!("ControlPath={}", template.to_string_lossy()));
        if let Some(port) = spec.port {
            cmd.arg("-p").arg(port.to_string());
        }
        cmd.arg(target);
        let out = cmd.output().ok()?;
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .find_map(|line| line.strip_prefix("controlpath "))
            .map(|p| PathBuf::from(p.trim()))
            .filter(|p| p.parent() == Some(control_dir().as_path()))
    }
}

/// Whether a ControlMaster is still listening on `path`. `ssh -O check` against
/// the explicit socket answers in microseconds and touches no network; the host
/// argument is required by the CLI but unused, since the socket is named outright
/// with `-o ControlPath`.
///
/// **`true` is the safe answer and therefore the default whenever we cannot
/// tell.** A spawn failure (no `ssh` on `PATH`, fork failure, `EMFILE`) is not
/// evidence about the socket, and every caller acts on a `false` by *deleting* —
/// so reading "could not ask" as "gone" would unlink live masters, whose channels
/// would then each need a credential nobody stored.
#[cfg(not(target_os = "windows"))]
pub fn control_master_alive(path: &std::path::Path) -> bool {
    crate::paths::command_no_window("ssh")
        .arg("-o")
        .arg(format!("ControlPath={}", path.to_string_lossy()))
        .arg("-O")
        .arg("check")
        .arg(concat!(crate::app_slug!(), "-control-probe"))
        .output()
        .map(|o| o.status.success())
        .unwrap_or(true)
}

/// The ControlMaster socket a process-table row belongs to, when that row is one
/// of **our** masters: a `[mux]`-titled `ssh` naming a `cm-*` path inside
/// `control_dir`. `None` for anything else, which is the whole safety property —
/// a foreign `ssh`, a user's own `ssh -M` and another tool's mux socket all fall
/// through untouched.
///
/// OpenSSH's mux master retitles itself `<control_path> [mux]` (`setproctitle` in
/// `muxserver_listen`), and on Linux that rewrites the argv area, so it is what
/// both `ps` and `/proc/<pid>/cmdline` report. The path is taken by anchoring on
/// the *whole* `<control_dir>/cm-` prefix and reading to the next whitespace —
/// not by splitting the row on spaces, which a state directory inside a home with
/// a space in it would defeat. The socket's own name (`cm-` + a hex hash) never
/// contains one.
///
/// Pure, so the predicate the sweep kills on is testable without a process table.
#[cfg(not(target_os = "windows"))]
pub fn mux_socket_in_row(row: &str, control_dir: &std::path::Path) -> Option<PathBuf> {
    if !row.contains("[mux]") {
        return None;
    }
    let anchor = format!("{}/cm-", control_dir.to_string_lossy());
    let start = row.find(&anchor)?;
    // Scan for the end of the token from *after* the anchor, never from `start`:
    // the directory half may legitimately contain a space (a home directory with
    // one), and only the `cm-<hash>` filename is guaranteed not to.
    let after = start + anchor.len();
    let end = row[after..]
        .find(char::is_whitespace)
        .map(|i| after + i)
        .unwrap_or(row.len());
    Some(PathBuf::from(&row[start..end]))
}

/// One `(pid, argv)` row of the process table, or `None` for a header/blank line.
#[cfg(not(target_os = "windows"))]
fn parse_ps_row(row: &str) -> Option<(i32, &str)> {
    let row = row.trim_start();
    let split = row.find(char::is_whitespace)?;
    let pid = row[..split].parse::<i32>().ok()?;
    Some((pid, row[split..].trim_start()))
}

/// The machine's process table as `(pid, argv)` rows. One `ps` spawn, which works
/// the same on Linux and macOS — deliberately not a `/proc` walk, which would be
/// Linux-only and would need a second implementation for the other Unix Tabtivity
/// ships on.
#[cfg(not(target_os = "windows"))]
fn process_rows() -> Vec<(i32, String)> {
    let Ok(out) = crate::paths::command_no_window("ps")
        .args(["-eo", "pid=,args="])
        .output()
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| parse_ps_row(l).map(|(pid, args)| (pid, args.to_string())))
        .collect()
}

/// Ask a `[mux]` master naming `path` to go away. SIGTERM only: the master's own
/// shutdown unlinks its socket and closes its channels, where a SIGKILL would
/// leave exactly the litter this function exists to collect.
#[cfg(not(target_os = "windows"))]
fn reap_masters_for(path: &std::path::Path, rows: &[(i32, String)]) -> usize {
    let dir = control_dir();
    let mut killed = 0;
    for (pid, args) in rows {
        if mux_socket_in_row(args, &dir).as_deref() == Some(path) {
            // SAFETY: `kill` takes no pointers; a pid that has already exited
            // fails harmlessly with ESRCH.
            if unsafe { libc::kill(*pid as libc::pid_t, libc::SIGTERM) } == 0 {
                killed += 1;
            }
        }
    }
    killed
}

/// Reconcile [`control_dir`] with the machine's actual ControlMasters — a startup
/// sweep beside `sandbox::sweep_orphans` / `openvpn::adopt_orphans`. Two failures,
/// which are each other's mirror image, and neither used to be reachable.
///
/// **A socket with no master.** Masters are killed by signal
/// (`services::remote::teardown_pooled`, and rather more abruptly by a crash or an
/// OOM), which leaves the socket file behind. A leftover socket is not inert: the
/// next `ssh` to that target logs "ControlSocket … already exists, disabling
/// multiplexing" and then **opens its own login** — so a single stale file
/// silently converts every later channel on that host from one shared
/// authenticated master into one connection each, for the rest of the run.
/// `ssh -O check` against the explicit socket answers in microseconds and touches
/// no network; a non-zero exit means nothing is listening, so unlink.
///
/// **A master with no socket** (G.25, observed 2026-08-03: four `[mux]` masters
/// alive with an *empty* control dir, each holding an ESTABLISHED `:22`
/// connection, two of them 2–3× past `ControlPersist=600`). That state was
/// unreachable by every mechanism we had — `ssh_close_master` asks *over* the
/// socket, the sweep above iterates files, and `ControlPersist` is the master's
/// own timer and had visibly not fired — so the only handle left is the pid.
/// Such a master is also unusable *as* a master: nobody can adopt a socket that
/// is gone, so we pay the open connection and get none of the warm-reconnect
/// benefit `RunEvent::Exit` deliberately leaves them up for. The predicate is safe
/// by construction, including against a **concurrent** Tabtivity, whose masters all
/// still have their files.
///
/// The two halves are also each other's fix. [`control_master_alive`] keeps its
/// conservative `true` default — "could not ask" genuinely is not evidence of
/// death, and reading it as death is what would unlink a *live* master's socket —
/// so instead the unlink no longer merely removes the file: it signals whatever
/// master still names it. Unlinking without killing is precisely what mints an
/// orphan, and that is the one step of the cycle we control.
///
/// Best effort throughout: a socket we cannot classify is left alone.
#[cfg(not(target_os = "windows"))]
pub fn sweep_stale_control_sockets() {
    let dir = control_dir();
    let rows = process_rows();

    // 1. Sockets whose master is gone (or unlinked-but-still-running).
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("cm-"))
            {
                continue;
            }
            // Only an `ssh` that actually RAN and said "not alive" licenses the
            // unlink — see [`control_master_alive`] for why "could not ask" counts
            // as alive here.
            if !control_master_alive(&path) {
                // Signal first, unlink second. If the check was a false negative
                // (a live master too busy to answer), removing the file alone
                // would strand it exactly as an orphan; asking it to exit means
                // the worst case is a master we shut down early, which the next
                // connect simply reopens.
                reap_masters_for(&path, &rows);
                let _ = std::fs::remove_file(&path);
            }
        }
    }

    // 2. Masters whose socket is gone. Nothing on disk names these, so they are
    //    reachable only from the process table.
    for (pid, args) in &rows {
        let Some(path) = mux_socket_in_row(args, &dir) else {
            continue;
        };
        if path.exists() {
            continue;
        }
        // SAFETY: `kill` takes no pointers; an already-exited pid fails with ESRCH.
        unsafe {
            libc::kill(*pid as libc::pid_t, libc::SIGTERM);
        }
    }
}

#[cfg(target_os = "windows")]
pub fn sweep_stale_control_sockets() {}

/// Single-quote `s` for a POSIX shell, escaping embedded single quotes as
/// `'\''`. The result parses back to exactly `s` regardless of spaces, `$`,
/// quotes, or other metacharacters. `pub(crate)` so command modules that build
/// their own host scripts (e.g. `commands::slurm`) share this one implementation
/// rather than reinventing shell quoting.
pub(crate) fn shell_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for ch in s.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

/// A POSIX-portable environment variable name (`[A-Za-z_][A-Za-z0-9_]*`). Used to
/// gate which keys may be `export`ed into the remote `$SHELL -c` string: the
/// value is `shell_quote`d, but the key is not (it sits left of `=`), so a key
/// containing shell metacharacters (e.g. `A; rm -rf ~ #`) would break out of the
/// assignment and run as a separate statement. Every key Tabtivity sets today is a
/// valid identifier; this enforces that property rather than trusting it.
pub(crate) fn is_valid_env_key(k: &str) -> bool {
    let mut chars = k.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// How a remote tab is wrapped in a **tmux** session on the host (TODO #85), so
/// the work is decoupled from the disposable ssh channel and survives a drop /
/// laptop sleep / Tabtivity relaunch.
#[derive(Debug, Clone)]
pub enum TmuxWrap {
    /// Start-or-attach a per-tab session (`tmux new-session -A`) that runs this
    /// tab's target command. On first spawn it creates and runs the command; on a
    /// reconnect/relaunch it reattaches and the target is ignored (the process is
    /// already running) — one command that is both "start" and "resume".
    Session(String),
    /// Attach to an **arbitrary named** session that already exists on the host
    /// (opened from the Sessions view, or a hand-started `tmux` session). No
    /// target command — `new-session -A` attaches the running session, or creates
    /// a bare login shell if the name is somehow gone.
    Attach(String),
}

/// tmux scrollback depth for Tabtivity-created sessions — and therefore the depth
/// the phone replay (`mobile_control::pty_bridge`) and the phone's own xterm
/// buffer are sized to: the three are one number by design, so what tmux
/// retains is what a reattach can show. tmux's own default is 2000 lines, which
/// silently bounded "the whole session" long before any client cap did.
///
/// A pane copies `history-limit` at creation, so it must be set *before*
/// `new-session` — which forces `-g` (there is no session to scope it to yet).
/// The wraps already set global options (`status off`, `mouse on`), so this
/// widens no footprint kind, only the retention number; like them it is
/// runtime server state that dies with the tmux server, never configuration
/// on disk.
pub const TMUX_HISTORY_LINES: u32 = 10_000;

/// Wrap a resolved `exec …` line in a tmux launch (see [`TmuxWrap`]). Emitted as
/// a POSIX-sh `if command -v tmux …` so a host **without** tmux degrades to the
/// plain exec (today's behavior) plus a one-line notice, instead of failing —
/// tmux is usually preinstalled on a compute/HPC host but cannot be assumed. The
/// session gets [`TMUX_HISTORY_LINES`] of scrollback (set before `new-session`,
/// since a pane copies the limit at creation), `status off` (Tabtivity already
/// draws tabs/layout, so tmux's status bar is redundant chrome) and `mouse on`
/// (wheel scrolls tmux history, so scrollback still feels native), chained as
/// extra tmux commands around a literal `;` argv separator.
///
/// `env_prefix` is the tab's `export …; ` statements, repeated *inside* the
/// session's target because a pane does not inherit them from the client (see
/// [`remote_command`]). A [`TmuxWrap::Attach`] takes none: it runs no target of
/// its own, and the session it attaches belongs to whoever created it.
fn tmux_wrap_exec(exec_line: &str, wrap: &TmuxWrap, env_prefix: &str) -> String {
    // The extra options are passed as separate tmux commands: a standalone
    // `;` token (quoted so the remote shell hands it to tmux literally, not as a
    // shell separator) splits tmux's argv into successive commands.
    let history = format!("set -g history-limit {TMUX_HISTORY_LINES} ';'");
    let opts = "';' set -g status off ';' set -g mouse on";
    match wrap {
        TmuxWrap::Session(name) => {
            let q = shell_quote(name);
            // Session-scoped, unlike the two globals above: the prefix is the
            // one key a user's own tmux sessions on the same server depend on.
            // Tabtivity's sessions have no use for it — both clients run with
            // `status off` and nothing binds the prefix — and with it off a
            // phone's raw keystrokes can reach only the pane, never tmux's own
            // command line (`docs/context/root_console.md`).
            let prefix = format!("';' set -t {q} prefix None");
            // tmux runs its command argument via `sh -c`, so the (quoted) exec
            // line — `exec "${SHELL:-/bin/bash}" -l…` — is executed exactly as it
            // would be directly, only now inside the persistent session, with the
            // tab's exports ahead of it so the pane has the same environment.
            let target = shell_quote(&format!("{env_prefix}{exec_line}"));
            let credential = if env_prefix.contains(concat!("LC_", crate::app_upper!(), "_ROOT_MCP_TOKEN")) {
                concat!(" -e \"LC_", crate::app_upper!(), "_ROOT_MCP_TOKEN=${LC_", crate::app_upper!(), "_ROOT_MCP_TOKEN:?}\"")
            } else { "" };
            format!(
                "if command -v tmux >/dev/null 2>&1; then \
                 exec tmux {history} new-session -A -D -s {q}{credential} {target} {opts} {prefix}; \
                 else printf '{SLUG}: tmux not found on the remote host; session persistence is OFF (install tmux to enable it)\\n' >&2; {exec_line}; fi"
            )
        }
        TmuxWrap::Attach(name) => {
            let q = shell_quote(name);
            format!(
                "if command -v tmux >/dev/null 2>&1; then \
                 exec tmux {history} new-session -A -D -s {q} {opts}; \
                 else printf '{SLUG}: tmux not found on the remote host; cannot attach session %s\\n' {q} >&2; exec \"${{SHELL:-/bin/bash}}\" -l; fi"
            )
        }
    }
}

/// Build the remote command string that `ssh` hands to the remote `$SHELL -c`.
///
/// Shape: `cd <dir> && export K=<v> … && exec <CMD>`. For a shell tab
/// (`local_cmd` empty) `<CMD>` is the remote login shell. For an agent/command
/// tab `<CMD>` is `"${SHELL:-/bin/bash}" -lc '<cli + args>'` — i.e. the command
/// is run through a **login** shell too, so the remote's PATH (e.g.
/// `~/.local/bin`, nvm, pyenv) is initialised and a userspace-installed CLI is
/// found. Without `-l`, ssh's non-login remote shell would miss those entries.
/// For a *recognised* agent CLI a detect-and-install prelude (see
/// `remote_agents`) is prepended inside the `-lc` script so the binary is
/// bootstrapped on the remote before it is exec'd.
/// `TERM`/`COLORTERM` are skipped — ssh forwards `TERM` to the remote PTY
/// already — as are agent-auth vars (`AGENT_AUTH_ENV`), so a local key cannot
/// clobber the remote agent's own stored login.
///
/// `tmux`, when `Some`, wraps the final `exec …` in a persistent tmux session
/// (TODO #85). Everything before it — the `cd`, the sorted env exports, the
/// agent bootstrap prelude — is preserved verbatim, and the exports are repeated
/// *inside* the session's target, since a tmux pane takes its environment from
/// the server rather than from the client that creates the session. So the wrap
/// changes only where the target runs, not what it is or what it sees. A
/// [`TmuxWrap::Attach`] ignores `local_cmd`/`local_args` (it attaches an existing
/// session, running no fresh target).
pub fn remote_command(
    local_cmd: &str,
    local_args: &[String],
    env: &HashMap<String, String>,
    remote_dir: &str,
    tmux: Option<&TmuxWrap>,
) -> String {
    let mut parts: Vec<String> = Vec::new();
    parts.push(format!("cd {}", shell_quote(remote_dir)));

    // Deterministic env order so the command is testable. Skip TERM/COLORTERM
    // (ssh forwards them to the remote PTY) and agent-auth vars (the remote uses
    // its own stored login — see AGENT_AUTH_ENV).
    let mut keys: Vec<&String> = env
        .keys()
        .filter(|k| {
            let k = k.as_str();
            // is_valid_env_key gates injection via a metacharacter-bearing key.
            is_valid_env_key(k) && k != "TERM" && k != "COLORTERM" && !AGENT_AUTH_ENV.contains(&k)
        })
        .collect();
    keys.sort();
    let exports: Vec<String> = keys
        .into_iter()
        .map(|k| if k == crate::services::root_mcp::TOKEN_ENV {
            // SSH sends this through its encrypted environment channel. The
            // stock VM sshd accepts LC_*; refusal fails before launching a CLI.
            concat!("export ", crate::app_upper!(), "_ROOT_MCP_TOKEN=\"${LC_", crate::app_upper!(), "_ROOT_MCP_TOKEN:?MCP credential channel unavailable}\"").to_string()
        } else { format!("export {}={}", k, shell_quote(&env[k])) })
        .collect();
    parts.extend(exports.iter().cloned());

    let exec = if local_cmd.is_empty() {
        // Login shell — let the remote pick its own $SHELL.
        "exec \"${SHELL:-/bin/bash}\" -l".to_string()
    } else {
        // Agent/command tab: run the command through a *login* shell so the
        // remote's PATH (~/.local/bin, nvm, pyenv, …) is set up and a
        // userspace-installed CLI resolves. Build the inner command line with
        // each token single-quoted, then quote the whole line again as the lone
        // argument to `$SHELL -lc`.
        let exec_cli = match host_side_resume(local_cmd, local_args) {
            // A Claude tab decides on the host whether this is a resume.
            Some((id, resume_args)) => format!(
                "if ls \"$HOME\"/.claude/projects/*/{} >/dev/null 2>&1; then {}; else {}; fi",
                shell_quote(&format!("{id}.jsonl")),
                exec_line(local_cmd, &resume_args),
                exec_line(local_cmd, local_args),
            ),
            None => exec_line(local_cmd, local_args),
        };
        // For a recognised agent, prepend a detect-and-install prelude so the
        // CLI is present on the remote before we exec it (see remote_agents).
        let inner = match remote_agents::recipe_for(local_cmd) {
            Some(recipe) => format!("{}; {}", remote_agents::bootstrap_prelude(recipe), exec_cli),
            None => exec_cli,
        };
        format!("exec \"${{SHELL:-/bin/bash}}\" -lc {}", shell_quote(&inner))
    };

    // The tmux wrap replaces only the final `exec …`; the `cd`/exports prefix is
    // untouched, so the non-tmux fallback branch inside the wrap still runs with
    // both. The exports are ALSO repeated inside the session's target: they run in
    // the shell that launches the tmux *client*, and tmux builds a new session's
    // environment from the server's global one rather than from that client, so
    // without this the pane gets the environment of whichever tab happened to
    // start the server (the local half of this is `tmux_local::local_tmux_args`).
    // The `cd` needs no such repeat — a new session does take its start directory
    // from the client.
    let env_prefix = if exports.is_empty() {
        String::new()
    } else {
        format!("{}; ", exports.join("; "))
    };
    let exec = match tmux {
        Some(wrap) => tmux_wrap_exec(&exec, wrap, &env_prefix),
        None => exec,
    };

    format!("{} && {}", parts.join(" && "), exec)
}

/// `exec 'cmd' 'arg' …` with every token single-quoted.
fn exec_line(cmd: &str, args: &[String]) -> String {
    let mut line = format!("exec {}", shell_quote(cmd));
    for a in args {
        line.push(' ');
        line.push_str(&shell_quote(a));
    }
    line
}

/// The host-side half of Claude session resume for a **remote** tab.
///
/// `services::agent_session` decides `--resume` vs `--session-id` by probing the
/// *local* `~/.claude/projects` — which, for a tab whose Claude runs on the
/// far host, never holds the log. So a restored remote tab always arrived here
/// as `--session-id <launch>`, and once the host had a transcript for that id
/// Claude refused it outright ("Session ID … is already in use"): the restored
/// tab died the moment its tmux session was gone (host reboot, an exited
/// agent). The remote command therefore asks the host itself — a transcript
/// named after the id under any project dir means resume — and only for a
/// uuid-shaped id, which is what lands in a shell glob. No hook runs on the
/// host, so a `/clear` there is not followed; the launch id is what comes back.
///
/// Returns the id and the args rewritten to `--resume`, or `None` when this is
/// not a Claude launch carrying a session id.
fn host_side_resume(local_cmd: &str, local_args: &[String]) -> Option<(String, Vec<String>)> {
    if local_cmd != "claude" {
        return None;
    }
    let i = local_args
        .iter()
        .position(|a| a == "--session-id" || a == "--resume")?;
    let id = local_args.get(i + 1)?.clone();
    if !crate::services::agent_session::is_uuid_shaped(&id) {
        return None;
    }
    let mut resume_args = local_args.to_vec();
    resume_args[i] = "--resume".to_string();
    Some((id, resume_args))
}

/// The tmux **kill-session** one-shot script fired on an *explicit* tab close of
/// a persistent remote tab (TODO #85). Closing the tab is the destructive intent
/// that ends the run; an app-exit / respawn leaves the session alive. A machine
/// disconnect ends every session on that host. Run over the pooled
/// ControlMaster via [`run_remote_script`]. The session name is `shell_quote`d
/// (it may be an arbitrary name from the Sessions view). `|| true` keeps the
/// exit status clean when the session is already gone.
pub fn tmux_kill_session_script(session: &str) -> String {
    format!(
        "tmux kill-session -t {} 2>/dev/null || true",
        shell_quote(session)
    )
}

/// Kill every tmux session owned by the connected SSH user. Used when Tabtivity
/// deliberately disconnects a remote machine, so its persistent runs do not
/// continue without their machine connection.
pub fn tmux_kill_server_script() -> &'static str {
    "tmux kill-server 2>/dev/null || true"
}

/// Whether `name` is a safe tmux session name to rename **to** (TODO #85): tmux
/// treats `:` and `.` specially, and a name with whitespace/control chars is a
/// footgun, so a rename target must be a non-empty run of `[A-Za-z0-9_-]`. (The
/// *source* name is not validated this way — a foreign/hand-started session may be
/// anything — only quoted.)
pub fn valid_tmux_session_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// The tmux **rename-session** one-shot (TODO #85): `tmux rename-session -t <old>
/// <new>`. Both names are `shell_quote`d (the `old` may be an arbitrary foreign
/// name); the caller MUST have checked `new` with [`valid_tmux_session_name`].
pub fn tmux_rename_session_script(old: &str, new: &str) -> String {
    format!(
        "tmux rename-session -t {} {}",
        shell_quote(old),
        shell_quote(new)
    )
}

/// The `tmux ls` one-shot that backs the Sessions view (TODO #85): one tab-
/// separated row per session — name, window count, created epoch, attached flag,
/// last-activity epoch, the active pane's current foreground command (used to
/// tell a busy session from one idling at its shell prompt), and the active
/// pane's current **directory** (which is what attributes a session to a project
/// when its *name* cannot — see [`session_visible_for_project`]).
/// `2>/dev/null || true` makes an absent tmux or a not-running server (`tmux ls`
/// exits non-zero with "no server running") a clean **empty** list rather than an
/// error (see [`parse_tmux_ls`]).
pub fn tmux_ls_script() -> &'static str {
    "tmux ls -F '#{session_name}\t#{session_windows}\t#{session_created}\t#{session_attached}\t#{session_activity}\t#{pane_current_command}\t#{pane_current_path}' 2>/dev/null || true"
}

/// Shell/login-interpreter names `pane_current_command` reports when a session is
/// sitting idle at its prompt (tmux prefixes a login shell with `-`, e.g. `-bash`).
/// Anything else running in the active pane counts as the session "working".
const IDLE_SHELL_COMMANDS: &[&str] = &[
    "bash", "-bash", "zsh", "-zsh", "sh", "-sh", "dash", "-dash", "fish", "-fish", "tcsh", "-tcsh",
    "csh", "-csh", "ksh", "-ksh", "pwsh", "-pwsh",
];

/// One host tmux session, as surfaced by the Sessions view (TODO #85).
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TmuxSession {
    /// Session name (`tabtivity-<uid>` for one Tabtivity started, else a foreign name).
    pub name: String,
    /// Number of windows in the session.
    pub windows: u32,
    /// Creation time, seconds since the Unix epoch (host clock).
    pub created: u64,
    /// Whether another client is currently attached to it.
    pub attached: bool,
    /// Last activity time, seconds since the Unix epoch (host clock) — bumped by
    /// output in any of the session's panes, so it doubles as "how long idle".
    pub activity: u64,
    /// The active pane's current foreground command (e.g. `python`, `vim`, or a
    /// shell name when idling at the prompt).
    pub current_command: String,
    /// Derived from `current_command`: false when the active pane is sitting at a
    /// bare shell prompt, true when something else is running in it.
    pub working: bool,
    /// The active pane's current working directory on the host. Empty when the
    /// host's `tmux ls` did not report it (an older format row). This is what
    /// attributes a session whose *name* carries no project id — every session
    /// minted before the name was scoped, and every hand-started one — to the
    /// project whose tree it is running in (see [`session_visible_for_project`]).
    pub current_path: String,
}

/// Parse the tab-separated output of [`tmux_ls_script`] into [`TmuxSession`]s.
/// Empty/`no server running` output → an empty list (never an error). A row that
/// does not have the four required fields is skipped rather than failing the whole
/// parse (forward-compatible with an unexpected `tmux ls` build); the two trailing
/// fields (added later) default to `0`/idle when a row is missing them, rather than
/// dropping the whole row, so an older-format row still surfaces.
pub fn parse_tmux_ls(output: &str) -> Vec<TmuxSession> {
    output
        .lines()
        .filter_map(|line| {
            let line = line.trim_end_matches('\r');
            if line.is_empty() {
                return None;
            }
            let mut f = line.split('\t');
            let name = f.next()?.to_string();
            if name.is_empty() {
                return None;
            }
            let windows = f.next()?.trim().parse().ok()?;
            let created = f.next()?.trim().parse().ok()?;
            // tmux prints `session_attached` as a count of attached clients; any
            // positive count means at least one client is on it.
            let attached = f.next()?.trim().parse::<u32>().ok()? > 0;
            let activity = f
                .next()
                .and_then(|v| v.trim().parse().ok())
                .unwrap_or(created);
            let current_command = f.next().map(|v| v.trim().to_string()).unwrap_or_default();
            let current_path = f.next().map(|v| v.trim().to_string()).unwrap_or_default();
            let working = !current_command.is_empty()
                && !IDLE_SHELL_COMMANDS.contains(&current_command.as_str());
            Some(TmuxSession {
                name,
                windows,
                created,
                attached,
                activity,
                current_command,
                working,
                current_path,
            })
        })
        .collect()
}

/// A project id can appear verbatim in a tmux session name (it's a uuid in
/// practice), but is not schema-guaranteed to be — mirrors the frontend's
/// `tmuxSession.ts` sanitizer (and `services::sandbox::sanitize_key`'s pattern)
/// so an oddly-shaped id can never produce an invalid prefix to match against.
fn sanitize_tmux_key(id: &str) -> String {
    let safe: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if safe.is_empty() {
        "x".to_string()
    } else {
        safe
    }
}

/// The `tabtivity-<project>--` prefix a session minted for `project_id` carries
/// (`lib/terminal/tmuxSession.ts`'s `newTmuxSessionName`). The `--` cannot occur inside
/// either half (a project id and a uuid are each single-hyphenated), so it
/// unambiguously separates the project id from the trailing uuid.
fn tmux_session_prefix_for(project_id: &str) -> String {
    format!("{}{}--", crate::brand::TMUX_PREFIX, sanitize_tmux_key(project_id))
}

/// Whether host path `path` is inside (or is) `root`. Both are normalized by
/// dropping trailing slashes, and the boundary is a real path segment — so
/// `/code/simplegnn2` is NOT inside `/code/simplegnn`. An empty `root` matches
/// nothing (a project with no known root can attribute nothing).
fn path_within(path: &str, root: &str) -> bool {
    let path = path.trim_end_matches('/');
    let root = root.trim_end_matches('/');
    if root.is_empty() || path.is_empty() {
        return false;
    }
    path == root || path.starts_with(&format!("{root}/"))
}

/// Whether a host tmux session should appear in **this** project's Sessions view
/// (TODO #85), on a host that several projects (and other people) share.
///
/// Two signals, in order:
///
/// 1. **The name.** A session minted after session names carried a project id is
///    `tabtivity-<project>--<uuid>`, which attributes it outright: this project's
///    prefix ⇒ shown, another project's ⇒ hidden. Nothing else can override this.
/// 2. **The working directory**, for every session the name cannot attribute —
///    the `tabtivity-<uuid>` ones minted before scoping existed (which on a
///    long-running cluster host outlive the fix by weeks) and every
///    hand-started/foreign session. A session whose active pane sits inside the
///    project's own tree belongs to it; one running elsewhere does not.
///
/// A row whose host `tmux ls` reported no path at all (an older format) is
/// **shown**: an unattributable session must not silently vanish. Nothing is
/// truly hidden either way — the Sessions view's "all host sessions" toggle
/// passes `include_all`, so an orphaned run always stays reachable to kill.
pub fn session_visible_for_project(
    name: &str,
    current_path: &str,
    own_project_id: &str,
    project_root: &str,
) -> bool {
    if name.starts_with(&tmux_session_prefix_for(own_project_id)) {
        return true;
    }
    // A session an older build minted carries the app's old prefix; it is
    // attributed the same way. (No old prefix while the name is unchanged.)
    let scoped = crate::services::brand_migration::compat::tmux_session_rest(&crate::brand::PAIR, name)
        .filter(|_| name.contains("--"));
    if scoped.is_some_and(|rest| rest.starts_with(&format!("{}--", sanitize_tmux_key(own_project_id)))) {
        return true;
    }
    // Another project's scoped name — the one case the name alone settles.
    if scoped.is_some() {
        return false;
    }
    if current_path.is_empty() {
        return true;
    }
    path_within(current_path, project_root)
}

/// Filter a host's tmux sessions down to the ones this project should see
/// (TODO #85). `include_all` is the Sessions view's "all host sessions" escape
/// hatch, which returns the listing untouched. See
/// [`session_visible_for_project`].
pub fn filter_sessions_for_project(
    sessions: Vec<TmuxSession>,
    project_id: &str,
    project_root: &str,
    include_all: bool,
) -> Vec<TmuxSession> {
    if include_all {
        return sessions;
    }
    sessions
        .into_iter()
        .filter(|s| session_visible_for_project(&s.name, &s.current_path, project_id, project_root))
        .collect()
}

/// Build the full `ssh` argv for an interactive remote PTY session running
/// `remote_command`. Returned as `Vec<String>` so it is unit-testable without
/// actually connecting.
///
/// Shape: `ssh -tt -o ControlMaster=auto -o ControlPath=… -o ControlPersist=… \
///         -o ServerAliveInterval=… -o ServerAliveCountMax=… \
///         [-p <port>] <[user@]host> <remote_command>`.
pub fn ssh_pty_args(remote: &RemoteSpec, remote_command: &str) -> Result<Vec<String>, String> {
    let target = ssh_target(&remote.user, &remote.host)?;
    // The seventh argv builder, and the one that opens a *master* for a tab —
    // so it carries the same dial policy as the six in `ssh_common`. A tab
    // restored at relaunch against a tagged HPC host would otherwise reach a
    // login node (and, tmux-wrapped, start a server there) with nobody asking.
    crate::services::ssh_common::authorize_dial(
        &remote.user,
        &remote.host,
        remote.port,
        crate::services::ssh_common::ambient_intent(&remote.user, &remote.host, remote.port),
    )?;

    let mut args: Vec<String> = vec!["-tt".to_string()];

    // Per-VM identity + known_hosts when this tab targets a live project VM's
    // forwarded port (`services::vm::vm_ssh_opts`; empty otherwise) — the tab
    // must authenticate with the per-VM key and never touch the user's real
    // `~/.ssh/known_hosts` for a host key we minted ourselves.
    args.extend(crate::services::vm::vm_ssh_opts(&remote.host, remote.port));

    // Connection multiplexing (ControlMaster/ControlPath/ControlPersist) is a
    // Unix-only OpenSSH feature: it relies on a Unix-domain control socket with
    // file-descriptor passing, which the Windows OpenSSH client does not
    // implement (it warns and the session can fail to bind the socket). Skip it
    // on Windows — each tab simply opens its own connection — while keeping the
    // reconnect/keepalive options below, which work on every platform.
    #[cfg(not(target_os = "windows"))]
    {
        let control_path = control_dir().join("cm-%C");
        args.push("-o".to_string());
        args.push("ControlMaster=auto".to_string());
        args.push("-o".to_string());
        args.push(format!("ControlPath={}", control_path.to_string_lossy()));
        args.push("-o".to_string());
        args.push(format!("ControlPersist={CONTROL_PERSIST_SECS}"));
    }

    for a in SSH_KEEPALIVE {
        args.push((*a).to_string());
    }
    if let Some(port) = remote.port {
        args.push("-p".to_string());
        args.push(port.to_string());
    }
    args.push(target);
    args.push(remote_command.to_string());
    Ok(args)
}

/// Build `ssh -S <shared-control-path> -O check <target>` for resolving the
/// actual ControlMaster PID without opening a network connection. The `%C`
/// token is expanded by OpenSSH from the same user/host/port tuple used by every
/// remote-project channel.
pub fn ssh_control_check_args(remote: &RemoteSpec) -> Result<Vec<String>, String> {
    let target = ssh_target(&remote.user, &remote.host)?;
    let control_path = control_dir().join("cm-%C");
    let mut args = vec![
        "-S".to_string(),
        control_path.to_string_lossy().into_owned(),
        "-O".to_string(),
        "check".to_string(),
    ];
    if let Some(port) = remote.port {
        args.push("-p".to_string());
        args.push(port.to_string());
    }
    args.push(target);
    Ok(args)
}

/// Build the remote command string `cd <remote_path> && git <args…>` for a
/// git-over-ssh invocation. This is the one unavoidable shell string: ssh
/// concatenates its trailing argv and hands it to the remote `$SHELL -c`, so
/// every token — `remote_path` and each git arg — is single-quoted via
/// [`shell_quote`] before it is embedded (the injection-safety requirement from
/// the mount-free plan's Security bullet). Pure + unit-testable.
pub fn remote_git_command(remote_path: &str, git_args: &[String]) -> String {
    let mut s = format!("cd {} && git", shell_quote(remote_path));
    for a in git_args {
        s.push(' ');
        s.push_str(&shell_quote(a));
    }
    s
}

/// Build the full `ssh` argv for running `git <git_args>` on `spec`'s host. The
/// shared-master base args (`ssh_base_args`: `BatchMode=yes`, `ConnectTimeout`,
/// and — on Unix — opportunistic reuse of the `cm-%C` ControlMaster the Phase-0
/// pooled connection / agent tabs establish) are followed by the single remote
/// `$SHELL -c` string from [`remote_git_command`]. `remote_path`/`host`/`user`
/// are validated (no leading `-`, no control chars) via `validate_arg`/
/// `ssh_target` inside `ssh_base_args` and here. Returned as `Vec<String>` so it
/// is unit-testable without connecting.
pub fn git_ssh_args(spec: &RemoteSpec, git_args: &[String]) -> Result<Vec<String>, String> {
    validate_arg("remote path", &spec.remote_path)?;
    let mut args = ssh_base_args(&spec.user, &spec.host, spec.port)?;
    args.push(remote_git_command(&spec.remote_path, git_args));
    Ok(args)
}

/// Run `git <git_args>` on `spec`'s host over SSH (riding the shared
/// ControlMaster) and capture its `Output`. Because git's output is plain text,
/// the caller parses it byte-for-byte identically to a local `git` invocation —
/// that is what lets `commands::git` reuse every existing parser unchanged for
/// remote projects. The remote `git`'s credentials/SSH keys are the host's own
/// (the process runs there), so e.g. `push` authenticates with the host login.
pub fn run_git_remote(
    spec: &RemoteSpec,
    git_args: &[String],
) -> Result<std::process::Output, String> {
    let args = git_ssh_args(spec, git_args)?;
    crate::paths::command_no_window("ssh")
        .args(&args)
        .output()
        .map_err(|e| format!("failed to run git over ssh: {e}"))
}

/// Run a single shell command on `spec`'s host over SSH (riding the shared
/// ControlMaster) and capture its `Output`. The command string is handed to the
/// remote `$SHELL -c`, so the caller MUST `shell_quote` any path/argument it
/// embeds. Used for cheap host capability probes (e.g. `command -v rsync`).
pub fn run_remote_shell(spec: &RemoteSpec, command: &str) -> Result<std::process::Output, String> {
    let mut args = ssh_base_args(&spec.user, &spec.host, spec.port)?;
    args.push(command.to_string());
    crate::paths::command_no_window("ssh")
        .args(&args)
        .output()
        .map_err(|e| format!("failed to run command over ssh: {e}"))
}

/// Run a POSIX-`sh` script inside the project's remote directory (`cd <path> && <script>`),
/// riding the shared ControlMaster. This is how `services::git_peer` collapses a probe
/// that cost six SSH round trips into one (#28p D5).
///
/// **`script` is embedded verbatim** — it is the shell program, so it cannot be quoted.
/// Callers must therefore pass a *constant* script, or one built only from values they
/// have proven inert (`git_peer::ancestry_script` interpolates hex object names and
/// nothing else). Never interpolate a path, branch name, or any other user-controlled
/// string into it; `remote_path` is the sole variable here and it is `shell_quote`d.
pub fn run_remote_script(spec: &RemoteSpec, script: &str) -> Result<std::process::Output, String> {
    validate_arg("remote path", &spec.remote_path)?;
    // The newline before `}` terminates the group's last command, so a script may end in
    // either `fi` or a trailing `;` without a syntax error either way.
    let cmd = format!("cd {} && {{ {script}\n}}", shell_quote(&spec.remote_path));
    run_remote_shell(spec, &cmd)
}

/// Best-effort recursive byte size of a directory on the host, over SSH.
///
/// Reports **apparent** size — the sum of each file's `st_size` — to match every
/// other size figure in the app: the local walk ([`crate::commands::fs`]'s
/// `walk_dir_size`) and the per-file SFTP listing sizes both use `st_size`. Plain
/// `du` instead reports **disk-block allocation** (each file rounded up to a 4 KB
/// block), which made an identical folder read *larger* over SSH than its local
/// mirror — e.g. 452 KB vs 377 KB for 31 small files, purely from block rounding.
///
/// `du -sb` gives exact apparent bytes on GNU coreutils (the usual Linux dev
/// host). BSD/macOS `du` has no `-b`, so when it produces nothing we fall back to
/// `du -sk` (1024-byte *block* units) × 1024 — approximate there, but no worse
/// than the previous behavior. The shell always emits **bytes**, so the parse
/// below never rescales. The path is validated + single-quoted; a `du` error
/// (e.g. unreadable dir) yields 0 rather than failing the whole listing.
pub fn remote_dir_size(spec: &RemoteSpec, remote_dir: &str) -> Result<u64, String> {
    validate_arg("remote path", remote_dir)?;
    let q = shell_quote(remote_dir);
    let cmd = format!(
        "s=$(du -sb {q} 2>/dev/null | cut -f1); \
         if [ -n \"$s\" ]; then echo \"$s\"; \
         else du -sk {q} 2>/dev/null | cut -f1 | awk '{{print $1*1024}}'; fi"
    );
    let out = run_remote_shell(spec, &cmd)?;
    let bytes: u64 = String::from_utf8_lossy(&out.stdout)
        .trim()
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .parse()
        .unwrap_or(0);
    Ok(bytes)
}

/// Full recursive size tree of a directory on the host, for the Disk Usage
/// Analyzer pane.
///
/// One `du -ak` round-trip (riding the shared ControlMaster) rather than an
/// N-call SFTP walk: `-a` reports files as well as directories, `-k` fixes the
/// unit at 1024-byte blocks (portable across GNU and BSD/macOS `du`, unlike
/// GNU-only `-b`), and `-x` keeps the scan on one filesystem so a network mount
/// or `/proc` under the root cannot make it run forever. `du` dedups hard links
/// itself. Parsing lives in [`crate::duscan::parse_du_output`], which is where the
/// output shape is documented and tested. The path is validated + single-quoted.
pub fn remote_du_tree(
    spec: &RemoteSpec,
    remote_dir: &str,
) -> Result<crate::duscan::DuScan, String> {
    validate_arg("remote path", remote_dir)?;
    let cmd = format!("du -ak -x {} 2>/dev/null", shell_quote(remote_dir));
    let out = run_remote_shell(spec, &cmd)?;
    // `du` exits non-zero when *any* entry was unreadable, having still printed
    // everything it could reach — so the status is ignored and stdout is parsed
    // regardless. An empty stdout (a genuinely dead connection) fails in the parser.
    crate::duscan::parse_du_output(remote_dir, &String::from_utf8_lossy(&out.stdout))
}

/// Raw `du -ak -x` capture of a host directory, riding the shared ControlMaster.
///
/// The same command `remote_du_tree` runs, but handed back as **text** rather than
/// pruned into a `DuScan`: the giant-folder census (`services::big_folders`) needs
/// every line — the emit caps that make a size *tree* renderable would silently
/// drop the folders it exists to find. One round trip; `-x` stays on this
/// filesystem, so a network mount under the project root isn't measured as project
/// data. `du` exits non-zero on any unreadable entry having printed the rest, so
/// stdout is returned regardless of status.
pub fn remote_du_raw(spec: &RemoteSpec, remote_dir: &str) -> Result<String, String> {
    validate_arg("remote path", remote_dir)?;
    let cmd = format!("du -ak -x {} 2>/dev/null", shell_quote(remote_dir));
    let out = run_remote_shell(spec, &cmd)?;
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    if text.trim().is_empty() {
        return Err("du returned nothing (is the host reachable?)".to_string());
    }
    Ok(text)
}

/// Best-effort create `spec.remote_path` (and parents) on the host over SSH,
/// riding the shared ControlMaster. Used when a new remote project is created so
/// agent tabs / git can `cd` into the project root. `mkdir -p <path>` is handed
/// to the remote `$SHELL -c`, so the path is single-quoted via `shell_quote` and
/// validated (no leading `-`, no control chars). Returns the trimmed stderr on
/// failure; callers treat it as best-effort.
pub fn remote_mkdir_p(spec: &RemoteSpec) -> Result<(), String> {
    validate_arg("remote path", &spec.remote_path)?;
    let mut args = ssh_base_args(&spec.user, &spec.host, spec.port)?;
    args.push(format!("mkdir -p {}", shell_quote(&spec.remote_path)));
    let out = crate::paths::command_no_window("ssh")
        .args(&args)
        .output()
        .map_err(|e| format!("failed to run mkdir over ssh: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Best-effort `git init` on the host inside `spec.remote_path`, but only when
/// that dir is not already a git work tree. Used when a remote project is
/// imported **with git support** (`git_type != "none"`) onto a host tree that
/// carries no repo: it gives git lockstep a repo on the (authoritative) host to
/// pair the local mirror from, matching how a fresh remote *create* leaves the
/// mirror as the repo. Idempotent — a path that is already a repo is left
/// untouched. The command is handed to the remote `$SHELL -c`, so the path is
/// single-quoted via `shell_quote` and validated; rides the shared ControlMaster.
pub fn remote_git_init(spec: &RemoteSpec) -> Result<(), String> {
    validate_arg("remote path", &spec.remote_path)?;
    let mut args = ssh_base_args(&spec.user, &spec.host, spec.port)?;
    let path = shell_quote(&spec.remote_path);
    args.push(format!(
        "cd {path} && git rev-parse --is-inside-work-tree >/dev/null 2>&1 || {init}",
        init = crate::services::git_init::INIT_SHELL
    ));
    let out = crate::paths::command_no_window("ssh")
        .args(&args)
        .output()
        .map_err(|e| format!("failed to run git init over ssh: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Build a ready-to-run shell command string that opens an **interactive** ssh
/// login to `[user@]host[:port]`, sharing the same multiplexing master socket
/// (`ControlPath`) the terminal/agent tabs use.
///
/// Typed into a root-scope shell tab (see the frontend `openConnectionInRoot`)
/// when the user has turned **off** headless connections: the password is entered
/// directly in the visible terminal — Tabtivity never handles it — and because the
/// login shares `cm-%C` with [`ssh_pty_args`], the pooled SFTP session, file
/// browse, and git-over-ssh all ride the authenticated master without a second
/// prompt. On Unix this enables `ControlMaster=auto`; on Windows
/// multiplexing is unavailable so the login simply opens its own connection. The
/// control-socket dir is created here so ssh can bind the master. Each argv item
/// is shell-quoted before being joined, so spaces/metacharacters stay inert.
pub fn interactive_login_command(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
) -> Result<String, String> {
    Ok(quote_join(&interactive_login_args(user, host, port)?))
}

/// The argv behind [`interactive_login_command`], before quoting — so a caller
/// that needs to append to it (a remote command to run in that same login, see
/// [`interactive_exec_command`]) builds on one definition of "how Tabtivity opens
/// an interactive ssh" rather than a second copy of the option list.
fn interactive_login_args(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
) -> Result<Vec<String>, String> {
    let target = ssh_target(user, host)?;
    let mut args: Vec<String> = vec!["ssh".to_string()];

    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::fs::create_dir_all(control_dir());
        let control_path = control_dir().join("cm-%C");
        args.push("-o".to_string());
        args.push("ControlMaster=auto".to_string());
        args.push("-o".to_string());
        args.push(format!("ControlPath={}", control_path.to_string_lossy()));
        args.push("-o".to_string());
        args.push(format!("ControlPersist={CONTROL_PERSIST_SECS}"));
    }

    for a in SSH_KEEPALIVE {
        args.push((*a).to_string());
    }
    if let Some(port) = port {
        args.push("-p".to_string());
        args.push(port.to_string());
    }
    args.push(target);
    Ok(args)
}

/// [`interactive_login_command`] with a command to **run** on the host instead of
/// a login shell — the visible-terminal counterpart of a headless
/// `run_ssh_auth`, for a one-off the user is meant to watch (the explicit
/// "install this agent CLI on that machine, in a terminal" action).
///
/// `-t` is what makes that worth doing: a PTY on the remote side means the
/// installer's own progress output arrives as it is written and an interactive
/// prompt it raises (a `sudo` password, a package manager's confirmation) is
/// answered in the terminal tab, exactly as the headless path cannot do. The
/// remote command is shell-quoted as a single argv item, so the caller composes
/// it as ordinary text without it being re-split by the local shell.
pub fn interactive_exec_command(
    user: &Option<String>,
    host: &str,
    port: Option<u16>,
    remote_command: &str,
) -> Result<String, String> {
    let mut args = interactive_login_args(user, host, port)?;
    args.push("-t".to_string());
    args.push(remote_command.to_string());
    Ok(quote_join(&args))
}

/// Shell-quote each argv item and join — so spaces/metacharacters stay inert in
/// the command line the frontend types into a shell tab.
fn quote_join(args: &[String]) -> String {
    args.iter()
        .map(|a| shell_quote(a))
        .collect::<Vec<_>>()
        .join(" ")
}

/// The remote host a non-`local_only` spawn of `opts` runs on, or `None` when
/// it runs here — the one decision [`wrap_pty_options`] acts on.
pub fn remote_target_of(opts: &PtyOptions) -> Option<crate::services::remote::RemoteTarget> {
    use crate::services::remote::{remote_target_for, remote_target_for_host, PRIMARY_HOST};
    let host_id = opts.remote_host_id.as_deref().unwrap_or(PRIMARY_HOST);
    // Untagged spawn (root/connection/local_only) → local.
    let id = opts.project_id.as_deref()?;
    // A worker id that no longer resolves (the machine was removed while a
    // tab still pointed at it) falls back to the PRIMARY on a remote project
    // rather than silently running local in the remote cwd (plan §8). A
    // genuinely local project still resolves to nothing → left as-is.
    remote_target_for_host(id, host_id)
        .or_else(|| remote_target_for(id).filter(|_| host_id != PRIMARY_HOST))
}

/// If `opts` belongs to a remote project, rewrite it in place to run the
/// requested command on the remote host via `ssh -tt`. No-op for local projects.
///
/// Remoteness is detected from `opts.project_id` (the explicit signal the
/// frontend sets for project-scope tabs): `remote_target_for` resolves it to a
/// `RemoteTarget`, or returns `None` for a local project. A spawn with no
/// `project_id` (root/connection terminals, `local_only` tabs) is always local.
/// The remote working dir is the project root (`spec.remote_path`).
///
/// On success, `opts.cmd` becomes `"ssh"`, `opts.args` the ssh argv, and
/// `opts.cwd` a stable local directory (the ssh client's local cwd is
/// irrelevant). Validation/connection failures surface as `Err`.
pub fn wrap_pty_options(opts: &mut PtyOptions) -> Result<(), String> {
    let Some(target) = remote_target_of(opts) else {
        return Ok(());
    };

    // Remote working dir is the project root on the host. There is no local
    // mountpoint to strip a subdir against (mount-free remote model).
    let remote_dir = target.spec.remote_path.trim_end_matches('/').to_string();
    validate_arg("remote dir", &remote_dir)?;

    // Ensure the control-socket directory exists before ssh tries to bind it.
    let _ = std::fs::create_dir_all(control_dir());

    // Persistent-session (tmux) wrap, TODO #85. An explicit attach (Sessions view /
    // restored attach tab) wins; otherwise a per-tab `tmux_session` name — minted
    // and persisted by the frontend for shell/script AND remote agent tabs of a
    // persist-enabled remote project (so it is stable across a relaunch, unlike the
    // PTY id) — spawns or reattaches that session. For an agent tab the name composes
    // with its `--resume`: this wrap nests the whole `$SHELL -lc '<bootstrap; exec cli
    // --resume …>'` target inside `new-session -A`, which reattaches the live agent
    // (ignoring the target) when the host session survived, or runs it fresh (resuming
    // the conversation) when it is gone. Absent (persistence off, local) → plain exec.
    let tmux = match (&opts.tmux_attach, &opts.tmux_session) {
        (Some(name), _) => Some(TmuxWrap::Attach(name.clone())),
        (None, Some(name)) => Some(TmuxWrap::Session(name.clone())),
        (None, None) => None,
    };

    let cmd_string = remote_command(&opts.cmd, &opts.args, &opts.env, &remote_dir, tmux.as_ref());
    let mut args = ssh_pty_args(&target.spec, &cmd_string)?;
    let mcp_token = opts.env.get(crate::services::root_mcp::TOKEN_ENV).cloned();
    if mcp_token.is_some() {
        args.splice(0..0, ["-o".into(), concat!("SendEnv=LC_", crate::app_upper!(), "_ROOT_MCP_TOKEN").into()]);
    }

    opts.cmd = "ssh".to_string();
    opts.args = args;
    // env is now embedded in the remote command; the local ssh client keeps only
    // TERM/COLORTERM, which build_command sets. Clear the rest to avoid leaking
    // local env into the ssh client process.
    opts.env.retain(|k, _| k == "TERM" || k == "COLORTERM");
    if let Some(token) = mcp_token {
        opts.env.insert(concat!("LC_", crate::app_upper!(), "_ROOT_MCP_TOKEN").into(), token.clone());
        // Kept for PTY teardown's generation-safe revocation, never in argv.
        opts.env.insert(crate::services::root_mcp::TOKEN_ENV.into(), token);
    }
    opts.cwd = storage::root_work_dir().to_string_lossy().into_owned();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(user: Option<&str>, host: &str, port: Option<u16>, remote_path: &str) -> RemoteSpec {
        RemoteSpec {
            user: user.map(str::to_string),
            host: host.to_string(),
            port,
            remote_path: remote_path.to_string(),
            openvpn: None,
            auto_connect: None,
            key_auth: None,
            persist_sessions: None,
            vm: None,
            label: None,
            extra: HashMap::new(),
        }
    }

    // ── shell_quote ────────────────────────────────────────────────────────

    #[test]
    fn reader_secret_never_enters_the_ssh_command_line() {
        let mut env = HashMap::new();
        env.insert(crate::services::root_mcp::TOKEN_ENV.into(), "secret-token-fixture".into());
        for tmux in [None, Some(TmuxWrap::Session("reader".into()))] {
            let command = remote_command("claude", &[], &env, "/work", tmux.as_ref());
            assert!(!command.contains("secret-token-fixture"));
            assert!(command.contains(concat!("LC_", crate::app_upper!(), "_ROOT_MCP_TOKEN")));
            assert!(command.contains("MCP credential channel unavailable"));
        }
    }

    #[test]
    fn shell_quote_wraps_and_escapes() {
        assert_eq!(shell_quote("abc"), "'abc'");
        assert_eq!(shell_quote("a b"), "'a b'");
        assert_eq!(shell_quote("$HOME"), "'$HOME'");
        // embedded single quote → '\''
        assert_eq!(shell_quote("a'b"), "'a'\\''b'");
    }

    // ── remote_command ─────────────────────────────────────────────────────

    #[test]
    fn remote_command_shell_uses_login_shell() {
        let cmd = remote_command("", &[], &HashMap::new(), "/srv/p", None);
        assert_eq!(cmd, "cd '/srv/p' && exec \"${SHELL:-/bin/bash}\" -l");
    }

    #[test]
    fn remote_command_agent_runs_under_login_shell() {
        // `mytool` is not a recognised agent, so there is no install prelude —
        // this isolates the login-shell wrapping. Agent tabs go through
        // `$SHELL -lc '<inner>'` so the remote PATH is set up; the inner command
        // line is `exec 'mytool' '--foo' 'bar baz'`, single-quoted again as the
        // lone -lc argument.
        let cmd = remote_command(
            "mytool",
            &["--foo".to_string(), "bar baz".to_string()],
            &HashMap::new(),
            "/srv/p",
            None,
        );
        assert_eq!(
            cmd,
            "cd '/srv/p' && exec \"${SHELL:-/bin/bash}\" -lc \
             'exec '\\''mytool'\\'' '\\''--foo'\\'' '\\''bar baz'\\'''"
        );
    }

    #[test]
    fn remote_command_agent_bootstraps_known_cli() {
        let cmd = remote_command("claude", &[], &HashMap::new(), "/srv/p", None);
        // Runs inside a login shell …
        assert!(cmd.starts_with("cd '/srv/p' && exec \"${SHELL:-/bin/bash}\" -lc "));
        // … with a detect-and-install prelude for the known CLI …
        assert!(cmd.contains("command -v claude >/dev/null 2>&1"));
        assert!(cmd.contains("curl -fsSL https://claude.ai/install.sh | bash"));
        assert!(cmd.contains("exit 127"));
        // … finally exec'ing the agent (single quotes escaped by the outer wrap).
        assert!(cmd.contains("exec '\\''claude'\\''"));
    }

    /// #28b's open half: the prelude used to fire for `claude` alone, so a Codex
    /// or Gemini tab on a host without the CLI exec'd straight into a bare
    /// "command not found". The recipe table decides; this pins that the seam
    /// actually consults it for more than one agent.
    #[test]
    fn remote_command_bootstraps_the_other_agent_clis() {
        for (bin, needle) in [
            (
                "codex",
                "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
            ),
            ("gemini", "npm install -g @google/gemini-cli"),
            (
                "agy",
                "curl -fsSL https://antigravity.google/cli/install.sh | bash",
            ),
            (
                "vibe",
                "curl -LsSf https://mistral.ai/vibe/install.sh | bash",
            ),
            ("opencode", "curl -fsSL https://opencode.ai/install | bash"),
        ] {
            let cmd = remote_command(bin, &[], &HashMap::new(), "/srv/p", None);
            assert!(
                cmd.contains(&format!("command -v {bin} >/dev/null 2>&1")),
                "{bin} gets no probe"
            );
            assert!(cmd.contains(needle), "{bin} gets no installer");
            assert!(cmd.contains("exit 127"), "{bin} does not abort on failure");
        }
    }

    /// An unrecognised command still gets **no** prelude — we never try to
    /// install something we don't know, and the generalization must not have
    /// turned the lookup into a catch-all.
    #[test]
    fn remote_command_leaves_an_unknown_cli_alone() {
        let cmd = remote_command("mytool", &[], &HashMap::new(), "/srv/p", None);
        assert!(!cmd.contains("command -v"));
        assert!(!cmd.contains("exit 127"));
    }

    /// A master's temporary socket must fit `sun_path`, or ssh logs in and then
    /// exits: the state dir is kept while it fits, the runtime dir takes over
    /// when it does not, and with no usable runtime dir nothing changes.
    /// Unix only: Windows has no control socket (`resolve_control_path`).
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn the_control_dir_leaves_room_for_the_master_socket() {
        use std::path::Path;
        let rt = Path::new("/run/user/1000");
        let short = Path::new(concat!("/s/", crate::app_slug!()));
        let long = Path::new(concat!("/home/someone/.local/share/", crate::app_slug!()));
        assert_eq!(pick_control_dir(Some(rt), short), short.join("ssh-control"));
        let moved = pick_control_dir(Some(rt), long);
        assert_eq!(moved, rt.join(concat!(crate::app_slug!(), "-ssh")));
        assert!(moved.as_os_str().len() + CONTROL_SOCKET_SUFFIX <= SOCKET_PATH_MAX);
        assert_eq!(pick_control_dir(None, long), long.join("ssh-control"));
        assert_eq!(pick_control_dir(Some(Path::new("run")), long), long.join("ssh-control"));
        // The exact bytes OpenSSH binds: `<dir>/cm-<40 hex>.<16 chars>`.
        let tmp = format!("{}/cm-{}.{}", moved.display(), "0".repeat(40), "x".repeat(16));
        assert_eq!(tmp.len(), moved.as_os_str().len() + CONTROL_SOCKET_SUFFIX);
    }

    /// **G.25's kill predicate.** The sweep signals a pid, so the one thing that
    /// must never be loose is *which rows it claims*: socketless-ours → reapable,
    /// socket-present-ours → left alone, anything foreign → not ours at all.
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn mux_row_predicate_claims_only_our_own_masters() {
        let dir = std::path::Path::new(concat!("/home/u/.local/share/", crate::app_slug!(), "/ssh-control"));
        let ours = concat!("ssh: /home/u/.local/share/", crate::app_slug!(), "/ssh-control/cm-a1b2c3 [mux]");
        assert_eq!(
            mux_socket_in_row(ours, dir).as_deref(),
            Some(std::path::Path::new(
                concat!("/home/u/.local/share/", crate::app_slug!(), "/ssh-control/cm-a1b2c3")
            ))
        );

        // Somebody else's multiplexer, in somebody else's directory.
        assert!(mux_socket_in_row("ssh: /tmp/other/cm-a1b2c3 [mux]", dir).is_none());
        // Our directory, but not a mux master — an ordinary session that merely
        // names the socket on its command line must never be signalled.
        assert!(mux_socket_in_row(
            concat!("ssh -o ControlPath=/home/u/.local/share/", crate::app_slug!(), "/ssh-control/cm-a1b2c3 host"),
            dir
        )
        .is_none());
        // A mux master of a *different* tool.
        assert!(mux_socket_in_row("ssh: /home/u/.ssh/cm-a1b2c3 [mux]", dir).is_none());
        // Unrelated processes.
        assert!(mux_socket_in_row("sshd: u@pts/3", dir).is_none());
        assert!(mux_socket_in_row("", dir).is_none());
    }

    /// A state directory inside a path with a space in it is why the path is read
    /// by anchoring on the whole prefix rather than by splitting the row.
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn mux_row_predicate_survives_a_space_in_the_state_dir() {
        let dir = std::path::Path::new(concat!("/home/My User/.local/share/", crate::app_slug!(), "/ssh-control"));
        let row = concat!("ssh: /home/My User/.local/share/", crate::app_slug!(), "/ssh-control/cm-ff00 [mux]");
        assert_eq!(
            mux_socket_in_row(row, dir).as_deref(),
            Some(std::path::Path::new(
                concat!("/home/My User/.local/share/", crate::app_slug!(), "/ssh-control/cm-ff00")
            ))
        );
    }

    /// The sweep reads `ps -eo pid=,args=`, whose rows are right-aligned pids
    /// followed by a full argv. A header or a blank line yields nothing.
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn ps_rows_split_into_pid_and_argv() {
        assert_eq!(
            parse_ps_row("  12345 ssh: /x/cm-a [mux]"),
            Some((12345, "ssh: /x/cm-a [mux]"))
        );
        assert_eq!(parse_ps_row("1 init"), Some((1, "init")));
        assert!(parse_ps_row("  PID COMMAND").is_none());
        assert!(parse_ps_row("").is_none());
        assert!(parse_ps_row("noPidHere").is_none());
    }

    /// The reaper resolves rows to pids by socket path, so a sweep of one dead
    /// socket cannot take a *sibling* master (a different host, its own live
    /// socket) down with it.
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn reaping_a_socket_never_matches_a_sibling_master() {
        let dir = control_dir();
        let target = dir.join("cm-dead");
        let sibling = dir.join("cm-live");
        let rows = [
            (111, format!("ssh: {} [mux]", target.display())),
            (222, format!("ssh: {} [mux]", sibling.display())),
        ];
        let matched: Vec<i32> = rows
            .iter()
            .filter(|(_, args)| mux_socket_in_row(args, &dir).as_deref() == Some(target.as_path()))
            .map(|(pid, _)| *pid)
            .collect();
        assert_eq!(matched, vec![111]);
    }

    #[test]
    fn remote_command_exports_env_sorted_and_skips_term() {
        let mut env = HashMap::new();
        env.insert("TERM".to_string(), "xterm".to_string());
        env.insert("COLORTERM".to_string(), "truecolor".to_string());
        env.insert("B_VAR".to_string(), "2".to_string());
        env.insert("A_VAR".to_string(), "x y".to_string());
        let cmd = remote_command("sh", &[], &env, "/srv/p", None);
        assert_eq!(
            cmd,
            "cd '/srv/p' && export A_VAR='x y' && export B_VAR='2' && \
             exec \"${SHELL:-/bin/bash}\" -lc 'exec '\\''sh'\\'''"
        );
    }

    #[test]
    fn remote_command_strips_agent_auth_env() {
        let mut env = HashMap::new();
        env.insert("ANTHROPIC_API_KEY".to_string(), "sk-local".to_string());
        env.insert("OPENAI_API_KEY".to_string(), "sk-oai".to_string());
        env.insert("KEEP_ME".to_string(), "1".to_string());
        let cmd = remote_command("sh", &[], &env, "/srv/p", None);
        // Auth vars (and their values) are never exported to the remote …
        assert!(!cmd.contains("ANTHROPIC_API_KEY"));
        assert!(!cmd.contains("OPENAI_API_KEY"));
        assert!(!cmd.contains("sk-local"));
        assert!(!cmd.contains("sk-oai"));
        // … but ordinary env still is.
        assert!(cmd.contains("export KEEP_ME='1'"));
    }

    #[test]
    fn remote_command_drops_env_key_with_shell_metachars() {
        // A key carrying shell metacharacters can't be made safe by quoting the
        // value (the key sits left of `=`), so it must be dropped entirely rather
        // than emitted as `export <metachars>=…`.
        let mut env = HashMap::new();
        env.insert("A; touch /tmp/pwned #".to_string(), "v".to_string());
        env.insert("GOOD_VAR".to_string(), "1".to_string());
        let cmd = remote_command("sh", &[], &env, "/srv/p", None);
        assert!(!cmd.contains("touch /tmp/pwned"));
        assert!(!cmd.contains("export A;"));
        assert!(cmd.contains("export GOOD_VAR='1'"));
    }

    // ── tmux wrap (TODO #85) ───────────────────────────────────────────────

    #[test]
    fn remote_command_off_is_unchanged() {
        // With no tmux wrap the output is byte-for-byte the pre-#85 command: the
        // cd/exports/exec nesting is untouched.
        let mut env = HashMap::new();
        env.insert("K".to_string(), "v".to_string());
        assert_eq!(
            remote_command("", &[], &env, "/srv/p", None),
            "cd '/srv/p' && export K='v' && exec \"${SHELL:-/bin/bash}\" -l"
        );
    }

    #[test]
    fn remote_command_tmux_wraps_shell_tab() {
        let wrap = TmuxWrap::Session(concat!(crate::app_slug!(), "-p1_shell-1").to_string());
        let cmd = remote_command("", &[], &HashMap::new(), "/srv/p", Some(&wrap));
        // cd prefix is preserved verbatim…
        assert!(cmd.starts_with("cd '/srv/p' && "));
        // …and the exec is a new-session -A -D on the derived name, with the login
        // shell exec nested as tmux's (quoted) command argument.
        assert!(cmd.contains("command -v tmux >/dev/null 2>&1"));
        // history-limit precedes new-session — a pane copies it at creation, so
        // chaining it after (like status/mouse) would leave the default 2000.
        assert!(cmd.contains(
            concat!("exec tmux set -g history-limit 10000 ';' new-session -A -D -s '", crate::app_slug!(), "-p1_shell-1' ")
        ));
        assert!(cmd.contains("'exec \"${SHELL:-/bin/bash}\" -l'"));
        // status/mouse options are chained as separate tmux commands; the
        // prefix is switched off for this session alone, never globally.
        assert!(cmd.contains(concat!("';' set -g status off ';' set -g mouse on ';' set -t '", crate::app_slug!(), "-p1_shell-1' prefix None;")));
        // Fallback: a host without tmux still runs the plain exec.
        assert!(cmd.contains("session persistence is OFF"));
        assert!(cmd.contains("; exec \"${SHELL:-/bin/bash}\" -l; fi"));
    }

    #[test]
    fn remote_command_lets_the_host_decide_a_claude_resume() {
        // The local probe cannot see the host's transcripts, so a restored remote
        // Claude tab arrives as `--session-id <launch>`; the host checks for a
        // log named after the id and resumes it, else starts fresh under it.
        let id = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
        let args = vec!["--session-id".to_string(), id.to_string()];
        let cmd = remote_command("claude", &args, &HashMap::new(), "/srv/p", None);
        // Inside the `$SHELL -lc '…'` argument every single quote is `'\''`.
        let q = |tok: &str| format!("'\\''{tok}'\\''");
        let expected = format!(
            "if ls \"$HOME\"/.claude/projects/*/{} >/dev/null 2>&1; then exec {} {} {}; else exec {} {} {}; fi",
            q(&format!("{id}.jsonl")),
            q("claude"),
            q("--resume"),
            q(id),
            q("claude"),
            q("--session-id"),
            q(id),
        );
        assert!(cmd.contains(&expected), "cmd: {cmd}\nexpected: {expected}");

        // Not uuid-shaped → no glob is built from it; plain exec as before.
        let args = vec!["--session-id".to_string(), "not-a-uuid".to_string()];
        let cmd = remote_command("claude", &args, &HashMap::new(), "/srv/p", None);
        assert!(!cmd.contains("if ls"));
        assert!(cmd.contains("exec '\\''claude'\\'' '\\''--session-id'\\'' '\\''not-a-uuid'\\''"));
        // Other agents are untouched.
        let args = vec!["resume".to_string(), id.to_string()];
        let cmd = remote_command("codex", &args, &HashMap::new(), "/srv/p", None);
        assert!(!cmd.contains("if ls"));
    }

    #[test]
    fn remote_command_tmux_repeats_env_inside_the_session() {
        // The outer exports run in the shell that launches the tmux CLIENT, and a
        // new session takes its environment from the tmux SERVER — so without the
        // repeat inside the target, the pane would get whichever tab started the
        // server (which is what stopped agents recording their session id).
        let mut env = HashMap::new();
        env.insert(crate::app_env!("TAB_UID").to_string(), "tab-1".to_string());
        let wrap = TmuxWrap::Session(concat!(crate::app_slug!(), "-p1_a1").to_string());
        let cmd = remote_command("claude", &[], &env, "/srv/p", Some(&wrap));
        assert!(cmd.starts_with(concat!("cd '/srv/p' && export ", crate::app_upper!(), "_TAB_UID='tab-1' && ")));
        // Inside tmux's (quoted) command argument, the same export leads the line.
        assert!(cmd.contains(concat!("'export ", crate::app_upper!(), "_TAB_UID='\\''tab-1'\\''; exec ")));
    }

    #[test]
    fn remote_command_tmux_wraps_command_tab_preserving_prelude() {
        let wrap = TmuxWrap::Session(concat!(crate::app_slug!(), "-p1_a1").to_string());
        let cmd = remote_command("claude", &[], &HashMap::new(), "/srv/p", Some(&wrap));
        // The agent bootstrap prelude is nested INSIDE the tmux target unchanged…
        assert!(cmd.contains("command -v claude >/dev/null 2>&1"));
        assert!(cmd.contains("curl -fsSL https://claude.ai/install.sh | bash"));
        // …and the whole `$SHELL -lc '<prelude; exec claude>'` line is tmux's
        // (quoted) command argument on the persistent session.
        assert!(cmd.contains(concat!("';' new-session -A -D -s '", crate::app_slug!(), "-p1_a1' ")));
    }

    #[test]
    fn remote_command_tmux_wraps_agent_resume_tab_preserving_resume_and_prelude() {
        // A remote agent tab now persists too (Claude/Codex/…): its `cli --resume …`
        // target, with the bootstrap prelude, is nested INSIDE `new-session -A` on the
        // frontend-minted per-tab name. `-A` reattaches the live agent on relaunch
        // (ignoring this target) or, if the session is gone, runs it — resuming the
        // conversation as before.
        let wrap = TmuxWrap::Session(concat!(crate::app_slug!(), "-p1--agent-uuid").to_string());
        let cmd = remote_command(
            "claude",
            &["--resume".to_string(), "sess-abc".to_string()],
            &HashMap::new(),
            "/srv/p",
            Some(&wrap),
        );
        // The cd prefix is preserved verbatim before the tmux launch.
        assert!(cmd.starts_with("cd '/srv/p' && "));
        // The bootstrap prelude is nested inside the tmux target unchanged…
        assert!(cmd.contains("command -v claude >/dev/null 2>&1"));
        assert!(cmd.contains("curl -fsSL https://claude.ai/install.sh | bash"));
        // …the resume args survive into the nested exec (run only on a fresh create)…
        assert!(cmd.contains("--resume"));
        assert!(cmd.contains("sess-abc"));
        // …and the whole thing is tmux's command argument on the persistent session.
        assert!(cmd.contains(concat!("';' new-session -A -D -s '", crate::app_slug!(), "-p1--agent-uuid' ")));
        // tmux-absent still runs the plain exec fallback.
        assert!(cmd.contains("session persistence is OFF"));
    }

    #[test]
    fn remote_command_tmux_attach_ignores_target() {
        let wrap = TmuxWrap::Attach("train".to_string());
        // Even with a target command, an attach ignores it and just reattaches the
        // named (possibly hand-started) session.
        let cmd = remote_command(
            "python",
            &["run.py".to_string()],
            &HashMap::new(),
            "/srv/p",
            Some(&wrap),
        );
        assert!(cmd.contains("exec tmux set -g history-limit 10000 ';' new-session -A -D -s 'train' "));
        // No fresh target is exec'd inside the attach (the session already runs).
        assert!(!cmd.contains("run.py"));
    }

    #[test]
    fn tmux_kill_session_script_quotes_name() {
        assert_eq!(
            tmux_kill_session_script(concat!(crate::app_slug!(), "-p1_shell-1")),
            concat!("tmux kill-session -t '", crate::app_slug!(), "-p1_shell-1' 2>/dev/null || true")
        );
        // An arbitrary/foreign name is single-quoted so it can't break out.
        assert!(tmux_kill_session_script("a'b").contains("'a'\\''b'"));
    }

    #[test]
    fn tmux_kill_server_script_is_best_effort() {
        assert_eq!(
            tmux_kill_server_script(),
            "tmux kill-server 2>/dev/null || true"
        );
    }

    #[test]
    fn parse_tmux_ls_reads_rows_and_tolerates_empty() {
        let out = concat!(crate::app_slug!(), "-p1_shell-1\t2\t1700000000\t1\t1700003600\t-bash\t/code/p1\ntrain\t1\t1700000500\t0\t1700009000\tpython\t/code/p1/run\n");
        let v = parse_tmux_ls(out);
        assert_eq!(v.len(), 2);
        assert_eq!(
            v[0],
            TmuxSession {
                name: concat!(crate::app_slug!(), "-p1_shell-1").into(),
                windows: 2,
                created: 1_700_000_000,
                attached: true,
                activity: 1_700_003_600,
                current_command: "-bash".into(),
                working: false,
                current_path: "/code/p1".into()
            }
        );
        assert_eq!(
            v[1],
            TmuxSession {
                name: "train".into(),
                windows: 1,
                created: 1_700_000_500,
                attached: false,
                activity: 1_700_009_000,
                current_command: "python".into(),
                working: true,
                current_path: "/code/p1/run".into()
            }
        );
        // "no server running" / absent tmux → empty output → zero sessions.
        assert!(parse_tmux_ls("").is_empty());
        assert!(parse_tmux_ls("\n").is_empty());
        // A malformed row is skipped, not fatal.
        assert!(parse_tmux_ls("onlyname\n").is_empty());
    }

    #[test]
    fn parse_tmux_ls_defaults_missing_trailing_fields() {
        // A row from an older-format `tmux ls` (missing activity/current_command)
        // still surfaces, rather than being dropped, with activity falling back to
        // `created` and the session read as idle.
        let v = parse_tmux_ls("legacy\t1\t1700000000\t0\n");
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].activity, 1_700_000_000);
        assert_eq!(v[0].current_command, "");
        assert_eq!(v[0].current_path, "");
        assert!(!v[0].working);
    }

    #[test]
    fn path_within_respects_segment_boundaries() {
        assert!(path_within("/code/proj", "/code/proj"));
        assert!(path_within("/code/proj/sub/dir", "/code/proj"));
        assert!(path_within("/code/proj/", "/code/proj"));
        // A sibling that merely shares a prefix is NOT inside it.
        assert!(!path_within("/code/proj2", "/code/proj"));
        assert!(!path_within("/code", "/code/proj"));
        // Nothing is inside an unknown root.
        assert!(!path_within("/code/proj", ""));
    }

    #[test]
    fn session_visible_scopes_by_name_then_by_working_directory() {
        let root = "/code/p1";
        // 1. The name settles it when it carries a project id, whatever the path.
        assert!(session_visible_for_project(
            concat!(crate::app_slug!(), "-p1--abcd"),
            "/somewhere/else",
            "p1",
            root
        ));
        assert!(!session_visible_for_project(
            concat!(crate::app_slug!(), "-p2--abcd"),
            "/code/p1",
            "p1",
            root
        ));
        // 2. Otherwise the working directory does. A legacy (pre-scoping) session
        //    running in this project's tree is this project's.
        assert!(session_visible_for_project(
            concat!(crate::app_slug!(), "-legacyuuid"),
            "/code/p1/src",
            "p1",
            root
        ));
        // …and one running in ANOTHER project's tree is not.
        assert!(!session_visible_for_project(
            concat!(crate::app_slug!(), "-legacyuuid"),
            "/code/p2",
            "p1",
            root
        ));
        // A hand-started session is attributed the same way.
        assert!(session_visible_for_project("train", "/code/p1", "p1", root));
        assert!(!session_visible_for_project(
            "train", "/home/me", "p1", root
        ));
        // A row whose host reported no path at all is unattributable → shown,
        // never silently dropped.
        assert!(session_visible_for_project("train", "", "p1", root));
        // An id needing sanitizing is matched consistently on both sides.
        assert!(session_visible_for_project(
            concat!(crate::app_slug!(), "-we_rd--abcd"),
            "/elsewhere",
            "we:rd",
            root
        ));
    }

    #[test]
    fn filter_sessions_for_project_scopes_and_honours_include_all() {
        let s = |name: &str, path: &str| TmuxSession {
            name: name.into(),
            windows: 1,
            created: 0,
            attached: false,
            activity: 0,
            current_command: "".into(),
            working: false,
            current_path: path.into(),
        };
        let sessions = vec![
            s(concat!(crate::app_slug!(), "-p1--a"), "/code/p1"),
            s(concat!(crate::app_slug!(), "-p2--b"), "/code/p2"),
            s("train", "/code/p1"), // hand-started inside this project
            s("other", "/home/me"), // hand-started elsewhere
            s(concat!(crate::app_slug!(), "-legacyuuid"), "/code/p1/run"), // pre-scoping, this project's tree
            s(concat!(crate::app_slug!(), "-legacyother"), "/code/p2/run"), // pre-scoping, another's tree
        ];
        let kept = filter_sessions_for_project(sessions.clone(), "p1", "/code/p1", false);
        let names: Vec<&str> = kept.iter().map(|x| x.name.as_str()).collect();
        assert_eq!(names, vec![concat!(crate::app_slug!(), "-p1--a"), "train", concat!(crate::app_slug!(), "-legacyuuid")]);
        // The escape hatch returns the host listing untouched, so an orphaned run
        // is always reachable to kill.
        assert_eq!(
            filter_sessions_for_project(sessions, "p1", "/code/p1", true).len(),
            6
        );
    }

    #[test]
    fn tmux_ls_script_tolerates_no_server() {
        let s = tmux_ls_script();
        assert!(s.contains("tmux ls -F"));
        // "no server running" (non-zero exit) and absent tmux both collapse to
        // empty output rather than an error.
        assert!(s.contains("2>/dev/null || true"));
    }

    #[test]
    fn is_valid_env_key_matches_posix_identifiers() {
        assert!(is_valid_env_key(crate::app_env!("TAB_UID")));
        assert!(is_valid_env_key("_x9"));
        assert!(!is_valid_env_key("9leading"));
        assert!(!is_valid_env_key("has space"));
        assert!(!is_valid_env_key("a;b"));
        assert!(!is_valid_env_key(""));
    }

    // ── ssh_pty_args ───────────────────────────────────────────────────────

    #[test]
    fn ssh_pty_args_shape() {
        let s = spec(Some("alice"), "host.example", None, "/srv/p");
        let args = ssh_pty_args(&s, "cd '/srv/p' && exec sh").unwrap();

        assert_eq!(args[0], "-tt");
        // Multiplexing is Unix-only: present on Unix, omitted on Windows.
        #[cfg(not(target_os = "windows"))]
        {
            assert!(args.iter().any(|a| a == "ControlMaster=auto"));
            assert!(args.iter().any(|a| a.starts_with("ControlPath=")));
            assert!(args.iter().any(|a| a.starts_with("ControlPersist=")));
        }
        #[cfg(target_os = "windows")]
        assert!(!args.iter().any(|a| a == "ControlMaster=auto"));
        assert!(args.iter().any(|a| a == "ServerAliveInterval=15"));
        // Interactive PTY: BatchMode must NOT be forced.
        assert!(!args.iter().any(|a| a == "BatchMode=yes"));
        // No port flag when port is None.
        assert!(!args.iter().any(|a| a == "-p"));
        // Target is a single argv item; remote command is the final item.
        assert!(args.iter().any(|a| a == "alice@host.example"));
        assert_eq!(args.last().unwrap(), "cd '/srv/p' && exec sh");
    }

    #[test]
    fn ssh_pty_args_includes_port() {
        let s = spec(None, "h", Some(2222), "/p");
        let args = ssh_pty_args(&s, "exec sh").unwrap();
        let pos = args.iter().position(|a| a == "-p").expect("-p present");
        assert_eq!(args[pos + 1], "2222");
    }

    #[test]
    fn ssh_pty_args_rejects_bad_host() {
        let s = spec(None, "-evil", None, "/p");
        assert!(ssh_pty_args(&s, "exec sh").is_err());
    }

    #[test]
    fn ssh_control_check_uses_shared_path_and_target() {
        let args =
            ssh_control_check_args(&spec(Some("alice"), "host.example", Some(2200), "/p")).unwrap();
        assert_eq!(args[0], "-S");
        assert!(args[1].contains("cm-%C"));
        assert!(args.windows(2).any(|w| w == ["-O", "check"]));
        assert!(args.windows(2).any(|w| w == ["-p", "2200"]));
        assert_eq!(args.last().unwrap(), "alice@host.example");
    }

    // ── interactive_login_command ──────────────────────────────────────────

    #[test]
    fn interactive_login_command_shape() {
        let cmd =
            interactive_login_command(&Some("alice".to_string()), "host.example", None).unwrap();
        // Starts with a (quoted) ssh and ends with the (quoted) target.
        assert!(cmd.starts_with("'ssh' "));
        assert!(cmd.contains("'alice@host.example'"));
        // Multiplexing master is SHARED with ssh_pty_args (same cm-%C socket), so a
        // root-terminal login's auth is reused by the headless mount/check.
        #[cfg(not(target_os = "windows"))]
        {
            assert!(cmd.contains("ControlMaster=auto"));
            assert!(cmd.contains("cm-%C"));
            assert!(cmd.contains("ControlPersist="));
        }
        #[cfg(target_os = "windows")]
        assert!(!cmd.contains("ControlMaster=auto"));
    }

    #[test]
    fn interactive_login_command_includes_port() {
        let cmd = interactive_login_command(&None, "h", Some(2222)).unwrap();
        assert!(cmd.contains("'-p' '2222'"));
        assert!(cmd.trim_end().ends_with("'h'"));
    }

    #[test]
    fn interactive_login_command_rejects_bad_target() {
        assert!(interactive_login_command(&None, "-evil", None).is_err());
        assert!(interactive_login_command(&Some("-evil".to_string()), "h", None).is_err());
    }

    // ── wrap_pty_options detection ─────────────────────────────────────────

    fn local_opts(cwd: &str, project_id: Option<&str>) -> PtyOptions {
        PtyOptions {
            id: "t".to_string(),
            cmd: "bash".to_string(),
            args: vec![],
            env: HashMap::new(),
            cwd: cwd.to_string(),
            cols: 80,
            rows: 24,
            local_only: false,
            sandbox: false,
            agent: false,
            project_id: project_id.map(str::to_string),
            remote_host_id: None,
            tmux_session: None,
            tmux_attach: None,
            host_bound_uid: None,
            local_model: false,
            schedule_target_id: None,
            host_session: false,
        }
    }

    #[test]
    fn wrap_pty_options_none_id_is_local_noop() {
        // No explicit project_id (root/connection/local_only spawn) → always
        // local, so the spawn is left untouched (mount-free: there is no cwd
        // mountpoint to sniff).
        let mut opts = local_opts("/home/user/proj", None);
        wrap_pty_options(&mut opts).unwrap();
        assert_eq!(opts.cmd, "bash");
        assert!(opts.args.is_empty());
    }

    // ── git over ssh ───────────────────────────────────────────────────────

    #[test]
    fn remote_git_command_quotes_path_and_each_arg() {
        let cmd = remote_git_command(
            "/srv/my project",
            &["status".to_string(), "--porcelain".to_string()],
        );
        assert_eq!(cmd, "cd '/srv/my project' && git 'status' '--porcelain'");
    }

    #[test]
    fn remote_git_command_no_args_is_bare_git() {
        assert_eq!(remote_git_command("/srv/p", &[]), "cd '/srv/p' && git");
    }

    #[test]
    fn git_ssh_args_shape_target_then_remote_command_last() {
        let s = spec(Some("alice"), "host.example", None, "/srv/p");
        let args = git_ssh_args(&s, &["status".to_string(), "--porcelain".to_string()]).unwrap();
        // BatchMode (rides/falls-back to key auth), target present as one item.
        assert!(args.iter().any(|a| a == "BatchMode=yes"));
        assert!(args.iter().any(|a| a == "alice@host.example"));
        // The remote $SHELL -c string is the final argv item.
        assert_eq!(
            args.last().unwrap(),
            "cd '/srv/p' && git 'status' '--porcelain'"
        );
        // Opportunistic ControlMaster reuse on Unix (shared cm-%C socket).
        #[cfg(not(target_os = "windows"))]
        {
            assert!(args.iter().any(|a| a == "ControlMaster=no"));
            assert!(args.iter().any(|a| a.contains("cm-%C")));
        }
    }

    #[test]
    fn git_ssh_args_includes_port() {
        let s = spec(None, "h", Some(2222), "/p");
        let args = git_ssh_args(&s, &["log".to_string()]).unwrap();
        let pos = args.iter().position(|a| a == "-p").expect("-p present");
        assert_eq!(args[pos + 1], "2222");
    }

    #[test]
    fn git_ssh_args_rejects_bad_remote_path_and_host() {
        // A remote path that could be read as an option is rejected before any
        // ssh runs (it would otherwise be embedded in the remote shell string).
        assert!(git_ssh_args(&spec(None, "h", None, "-rf"), &["status".to_string()]).is_err());
        assert!(git_ssh_args(&spec(None, "-evil", None, "/p"), &["status".to_string()]).is_err());
    }
}

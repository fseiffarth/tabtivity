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
    let dir = pick_control_dir(runtime.as_deref(), &storage::state_dir(), private_tmp_control_dir);
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
///
/// With neither — the server daemon (hosted plan §3.1): a system unit gets no
/// `$XDG_RUNTIME_DIR`, and its state dir `~/.local/share/<slug>-server` never
/// leaves room — `private_tmp` is asked for `/tmp/<slug>-ssh-<uid>`, used
/// only when it is a directory this uid owns with mode `0700` (the daemon's
/// `/tmp` is its unit's private one; fenced tabs get their own `/tmp`).
fn pick_control_dir(
    runtime: Option<&std::path::Path>,
    state_dir: &std::path::Path,
    private_tmp: impl FnOnce() -> Option<PathBuf>,
) -> PathBuf {
    let fits = |dir: &std::path::Path| dir.as_os_str().len() + CONTROL_SOCKET_SUFFIX <= SOCKET_PATH_MAX;
    let in_state = state_dir.join("ssh-control");
    if fits(&in_state) {
        return in_state;
    }
    match runtime.filter(|rt| rt.is_absolute()) {
        Some(rt) if fits(&rt.join(concat!(crate::app_slug!(), "-ssh"))) => {
            rt.join(concat!(crate::app_slug!(), "-ssh"))
        }
        _ => private_tmp().filter(|dir| fits(dir)).unwrap_or(in_state),
    }
}

/// `/tmp/<slug>-ssh-<uid>`, created `0700`, and returned only when it is a
/// real directory (not a link) owned by this uid that no one else can enter
/// — on a shared `/tmp` another account could have made it first.
#[cfg(unix)]
fn private_tmp_control_dir() -> Option<PathBuf> {
    use std::os::unix::fs::DirBuilderExt;
    // SAFETY: geteuid has no preconditions.
    let uid = unsafe { libc::geteuid() };
    let dir = PathBuf::from("/tmp").join(format!("{}-ssh-{uid}", crate::app_slug!()));
    let _ = std::fs::DirBuilder::new().mode(0o700).create(&dir);
    owned_private_dir(&dir, uid).then_some(dir)
}

#[cfg(not(unix))]
fn private_tmp_control_dir() -> Option<PathBuf> {
    None
}

#[cfg(unix)]
fn owned_private_dir(dir: &std::path::Path, uid: u32) -> bool {
    use std::os::unix::fs::MetadataExt;
    std::fs::symlink_metadata(dir).is_ok_and(|m| m.is_dir() && m.uid() == uid && m.mode() & 0o077 == 0)
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
///
/// `ssh -G` evaluates the user's ssh_config, `Match exec` commands included, so
/// it runs under [`RESOLVE_TIMEOUT`]: a `Match exec` that hangs is killed with
/// its process group, and the answer is `None`.
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
        let out = crate::paths::output_within(cmd, RESOLVE_TIMEOUT).ok()?;
        controlpath_of(&out.stdout)
    }
}

/// How long [`resolve_control_path`]'s `ssh -G` may take.
pub const RESOLVE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// The `controlpath` line of `ssh -G`'s output, when it names a socket in
/// [`control_dir`] — never a path elsewhere.
#[cfg(not(target_os = "windows"))]
fn controlpath_of(ssh_g_stdout: &[u8]) -> Option<PathBuf> {
    String::from_utf8_lossy(ssh_g_stdout)
        .lines()
        .find_map(|line| line.strip_prefix("controlpath "))
        .map(|p| PathBuf::from(p.trim()))
        .filter(|p| p.parent() == Some(control_dir().as_path()))
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

/// POSIX single-quoting ([`crate::quote::posix`]) under the name the remote
/// script builders here and in `commands::*` already use.
pub(crate) use crate::quote::posix as shell_quote;

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
            Some((id, resume_args, fresh_args)) => format!(
                "if ls \"$HOME\"/.claude/projects/*/{} >/dev/null 2>&1; then {}; else {}; fi",
                shell_quote(&format!("{id}.jsonl")),
                exec_line(local_cmd, &resume_args),
                exec_line(local_cmd, &fresh_args),
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
/// The other way round, a tab moved from this machine onto the host arrives as
/// `--resume <id>`, because the local probe found the log of its local run.
/// The host has no such log, and `claude --resume` of an unknown id exits at
/// once — so the no-log branch always starts fresh under `--session-id`.
///
/// Returns the id and the args rewritten to `--resume` and to `--session-id`,
/// or `None` when this is not a Claude launch carrying a session id.
fn host_side_resume(local_cmd: &str, local_args: &[String]) -> Option<(String, Vec<String>, Vec<String>)> {
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
    let mut fresh_args = local_args.to_vec();
    fresh_args[i] = "--session-id".to_string();
    Some((id, resume_args, fresh_args))
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

/// The `tabtivity-<project>--` prefix a session minted for `project_id` carries
/// (`lib/terminal/tmuxSession.ts`'s `newTmuxSessionName`). The `--` cannot occur inside
/// either half (a project id and a uuid are each single-hyphenated), so it
/// unambiguously separates the project id from the trailing uuid.
fn tmux_session_prefix_for(project_id: &str) -> String {
    format!("{}{}--", crate::brand::TMUX_PREFIX, crate::storage::project_key(project_id))
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
    if scoped.is_some_and(|rest| rest.starts_with(&format!("{}--", crate::storage::project_key(own_project_id)))) {
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

// ── The phone sidecar's no-dial lane ───────────────────────────────────────
//
// The phone reaches a remote-host tab's tmux session through the desktop's
// ControlMaster for that host and nothing else
// (`docs/mobile_remote_host_tabs_plan.md`): it never opens a connection and
// never prompts. Everything below is pure argv/string building, compiled and
// tested on every OS; only [`master_alive`] spawns.

/// The `ssh` argv that runs `host_command` on `spec`'s host **only through the
/// master already listening on `control_path`** — the literal socket path
/// [`resolve_control_path`] read, never the `cm-%C` template: `%C` hashes the
/// ProxyJump too, and the `ProxyCommand=false` below suppresses a configured
/// one, so the template would name a different socket than the desktop's
/// master for every ProxyJump host.
///
/// Why it cannot dial: OpenSSH tries the mux client on the ControlPath before
/// it resolves or connects anything. With `ControlMaster=no`, a missing socket,
/// a dead master or one that refuses the session (sshd's `MaxSessions`) falls
/// through to a normal connection, which `ProxyCommand=false` turns into
/// running `false` locally — no DNS lookup, no TCP connect, exit 255. The
/// command line wins over the user's `ProxyCommand`/`ProxyJump`. So it takes
/// no `ssh_common::authorize_dial` (it never dials) and no `ssh_base_args`,
/// whose `ControlMaster=no` falls through to a fresh key/agent login.
///
/// `-e none`: the phone's keystrokes pass through this client's PTY, so `~.`
/// and `~C` must be plain text. `-q` keeps "Shared connection … closed" off
/// the phone's screen. `-F none` reads no ssh_config at all (the mux client
/// needs nothing from it): no `Match exec` runs on the 10 s probes and
/// `CanonicalizeHostname` resolves nothing. `RemoteCommand=none` and
/// `ClearAllForwardings=yes` stay as a second line against a config that
/// replaces the command or asks the master for its port forwards. `tty` picks `-tt` (the attach) or `-T` (the one-shots). `--`
/// ends ssh's options before the host command.
pub fn host_mux_args(
    spec: &RemoteSpec,
    control_path: &std::path::Path,
    tty: bool,
    host_command: &str,
) -> Result<Vec<String>, String> {
    let target = ssh_target(&spec.user, &spec.host)?;
    let path = literal_control_path(control_path)?;
    let mut args: Vec<String> = vec![
        "-F".to_string(),
        "none".to_string(),
        if tty { "-tt" } else { "-T" }.to_string(),
        "-q".to_string(),
        "-e".to_string(),
        "none".to_string(),
    ];
    for option in [
        "BatchMode=yes".to_string(),
        "ControlMaster=no".to_string(),
        format!("ControlPath={path}"),
        "ProxyCommand=false".to_string(),
        "ClearAllForwardings=yes".to_string(),
        "ForwardAgent=no".to_string(),
        "ForwardX11=no".to_string(),
        "PermitLocalCommand=no".to_string(),
        "RemoteCommand=none".to_string(),
    ] {
        args.push("-o".to_string());
        args.push(option);
    }
    if let Some(port) = spec.port {
        args.push("-p".to_string());
        args.push(port.to_string());
    }
    args.push(target);
    args.push("--".to_string());
    args.push(host_command.to_string());
    Ok(args)
}

/// [`host_mux_args`] for the host's SFTP subsystem (`-s … -- sftp`): the
/// phone's read-only view of a remote project's tree (`mobile_control::
/// host_files`), over the same master and just as unable to dial.
pub fn host_mux_sftp_args(spec: &RemoteSpec, control_path: &std::path::Path) -> Result<Vec<String>, String> {
    let mut args = host_mux_args(spec, control_path, false, "sftp")?;
    // `… <target> -- sftp`: `-s` goes in front of the target, with the options.
    let target_at = args.len() - 3;
    args.insert(target_at, "-s".to_string());
    Ok(args)
}

/// `control_path` as the one `-o ControlPath=` value it may be: absolute, and
/// with nothing ssh would read as more than a path — a `%` token it would
/// expand, whitespace that would split the option, a control character.
fn literal_control_path(control_path: &std::path::Path) -> Result<String, String> {
    let path = control_path.to_string_lossy();
    if !control_path.is_absolute()
        || path.contains('%')
        || path.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err("control path is not a literal socket path".to_string());
    }
    validate_arg("control path", &path)?;
    Ok(path.into_owned())
}

/// `ssh -O check` on the literal socket `control_path`: asks the master
/// whether it is alive, over the socket alone. A `-O` command whose socket
/// does not answer exits; it never falls back to a connection, and
/// `ProxyCommand=false` is there all the same.
pub fn master_check_args(control_path: &std::path::Path) -> Result<Vec<String>, String> {
    let path = literal_control_path(control_path)?;
    Ok(vec![
        "-F".to_string(),
        "none".to_string(),
        "-o".to_string(),
        "BatchMode=yes".to_string(),
        "-o".to_string(),
        "ControlMaster=no".to_string(),
        "-o".to_string(),
        format!("ControlPath={path}"),
        "-o".to_string(),
        "ProxyCommand=false".to_string(),
        "-O".to_string(),
        "check".to_string(),
        concat!(crate::app_slug!(), "-control-probe").to_string(),
    ])
}

/// Whether a ControlMaster answers on `control_path` within `limit` — the
/// **strict** reading, for the phone sidecar, which acts on `true` by riding
/// the master: anything short of the master saying yes (no `ssh`, a spawn
/// failure, a hung master, Windows, which has no masters) is `false`.
/// [`control_master_alive`] is the opposite reading, for callers that act on
/// `false` by deleting.
pub fn master_alive(control_path: &std::path::Path, limit: std::time::Duration) -> bool {
    if cfg!(target_os = "windows") {
        return false;
    }
    let Ok(args) = master_check_args(control_path) else {
        return false;
    };
    let mut command = crate::paths::command_no_window("ssh");
    command.args(args);
    crate::paths::output_within(command, limit).is_ok_and(|out| out.status.success())
}

/// Sets `e` (and `c`) at the head of a host-side tmux script: `=` (and `:`)
/// where the host's tmux has the exact-match target prefix (2.1 and later:
/// `-t "$e"name` is then that session only, never a prefix match of a longer
/// name of the user's own), both empty on an older one, whose bare name is the
/// only form it knows (an HPC image with tmux 1.8). Read off `tmux -V`, so one
/// round trip carries both; an answer that is no version at all counts as new
/// (the commands fail on a host with no tmux either way).
const HOST_TMUX_EXACT: &str = "case \"$(tmux -V 2>/dev/null)\" in \"tmux \"[01].*|\"tmux 2.0\"*) e=; c=;; *) e==; c=:;; esac; ";

/// A host-side tmux script as one `sh -c` of its own: the remote's `$SHELL -c`
/// may be fish or csh, which read neither `case` nor `e==`. `body` holds no
/// single quote (the session name is validated, so it is bare in it).
fn host_sh(body: &str) -> String {
    debug_assert!(!body.contains('\''));
    format!("exec sh -c '{body}'")
}

/// The host-side attach the phone's PTY runs through [`host_mux_args`]: plain
/// `tmux` in a `sh` of the remote's non-login `$SHELL -c`, the way the desktop's
/// wrap started the session ([`remote_command`]), so the same binary and server
/// answer. The target is the exact name (`=`, [`HOST_TMUX_EXACT`]) where the
/// host's tmux has it; on an older one the bare name is validated and the
/// `has-session` guard runs first. `None` for a name that is not
/// [`valid_tmux_session_name`].
///
/// Silent when it cannot attach: the remote PTY carries stderr to the phone's
/// screen, and tmux's refusals name what must never cross the browser API —
/// `can't find session: <name>` (the scope's raw id is in the name), `no
/// server running on /tmp/tmux-<uid>/default`, the shell's `tmux: not found`.
/// A host tab reads as available on its master alone where the host's tmux
/// is not asked (no window up, an HPC host), so attaching to a session that
/// has ended is the ordinary case here, not a race: `has-session` gates the
/// attach and both keep stderr off the PTY. The phone sees the stream end.
pub fn host_tmux_attach_command(session: &str) -> Option<String> {
    valid_tmux_session_name(session).then(|| {
        host_sh(&format!(
            "{HOST_TMUX_EXACT}tmux -u has-session -t \"$e\"{session} 2>/dev/null && exec tmux -u attach-session -t \"$e\"{session} 2>/dev/null"
        ))
    })
}

/// The host-side history capture, the local bridge's `capture-pane` flags: the
/// last `lines` of history, ending one line above the visible screen.
pub fn host_tmux_capture_command(session: &str, lines: usize) -> Option<String> {
    valid_tmux_session_name(session).then(|| {
        host_sh(&format!(
            "{HOST_TMUX_EXACT}tmux -u capture-pane -p -e -J -S -{lines} -E -1 -t \"$e\"{session}\"$c\""
        ))
    })
}

/// The host-side window-size probe: `<cols>x<rows>` of the session's window.
pub fn host_tmux_window_size_command(session: &str) -> Option<String> {
    valid_tmux_session_name(session).then(|| {
        host_sh(&format!(
            "{HOST_TMUX_EXACT}tmux -u display-message -p -t \"$e\"{session}\"$c\" \"#{{window_width}}x#{{window_height}}\""
        ))
    })
}

/// The host-side Send now (`pty_bridge::QueueHint`): Esc into the session's
/// pane, only while a row of its screen starts with `row_start` and holds
/// `words` — the CLI saying a message still waits in its queue. Check and
/// press are one script on the host, so no ssh round trip falls between
/// them; shell builtins and tmux only. The match runs byte-wise (`LC_ALL=C`):
/// macOS's bash 3.2 `sh` never matches a quoted multibyte char (the prompt's
/// `❯`) against a pattern in a UTF-8 locale. Its case pattern opens with `(`:
/// bash 3.2 otherwise takes the pattern's `)` for the end of the `$(…)`.
/// Prints `sent` when it pressed. `None`
/// for an invalid name, or a hint that could break out of its quotes.
pub fn host_tmux_send_now_command(session: &str, row_start: &str, words: &str) -> Option<String> {
    let quotable = |text: &str| !text.chars().any(|c| matches!(c, '\'' | '"' | '\\' | '$' | '`') || c.is_control());
    (valid_tmux_session_name(session) && quotable(row_start) && quotable(words)).then(|| {
        host_sh(&format!(
            "{HOST_TMUX_EXACT}t=\"$e\"{session}\"$c\"; \
             q=$(tmux -u capture-pane -p -J -t \"$t\" | (LC_ALL=C; while IFS= read -r l; do case \"$l\" in (\"{row_start}\"*\"{words}\"*) echo 1;; esac; done)); \
             [ -n \"$q\" ] && tmux send-keys -t \"$t\" Escape && echo sent"
        ))
    })
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
    git_ssh_args_within(spec, git_args, None)
}

/// [`git_ssh_args`] with the remote command from [`bounded_remote_git_command`].
pub fn git_ssh_args_within(spec: &RemoteSpec, git_args: &[String], host_secs: Option<u64>) -> Result<Vec<String>, String> {
    validate_arg("remote path", &spec.remote_path)?;
    let mut args = ssh_base_args(&spec.user, &spec.host, spec.port)?;
    args.push(bounded_remote_git_command(&spec.remote_path, git_args, host_secs));
    Ok(args)
}

/// Run `git <git_args>` on `spec`'s host over SSH (riding the shared
/// ControlMaster) and capture its `Output`. Because git's output is plain text,
/// the caller parses it byte-for-byte identically to a local `git` invocation —
/// that is what lets `commands::git` reuse every existing parser unchanged for
/// remote projects. The remote `git`'s credentials/SSH keys are the host's own
/// (the process runs there), so e.g. `push` authenticates with the host login.
///
/// Bounded like a local git call: a wedged ControlMaster or a hung host must
/// not pile blocked workers up behind the git bar's poll — for a remote-only
/// project every git call takes this path. The ceiling is the git verb's
/// (`git_bounded::wrapped_output`, read off `git_args` before they are wrapped
/// into the one ssh command string), and a timeout reaps the ssh child. Killing
/// that child does not stop the git on the host (no pty, so no hangup reaches
/// it), so when the host has `timeout` the call runs under it too, a little
/// past the same ceiling ([`bounded_remote_git_command`]).
///
/// A hooks-off call whose verb runs a hook is refused on a host git too old to
/// turn hooks off (`git_hardened::host_hooks_off_refusal`); the host's git and
/// `timeout` are probed once per host (`git_hardened::host_git`).
pub fn run_git_remote(
    spec: &RemoteSpec,
    git_args: &[String],
) -> Result<std::process::Output, String> {
    // A spec ssh would refuse fails here, before anything is probed.
    git_ssh_args(spec, git_args)?;
    let host = crate::services::git_hardened::host_git(spec);
    if let Some(refusal) = crate::services::git_hardened::host_hooks_off_refusal(host.version, git_args) {
        return Err(refusal);
    }
    let args = git_ssh_args_within(spec, git_args, host.timeout.then(|| host_timeout_secs(git_args)))?;
    let mut cmd = crate::paths::command_no_window("ssh");
    cmd.args(&args);
    crate::services::git_bounded::wrapped_output(cmd, git_args, host.timeout)
        .map_err(|e| format!("failed to run git over ssh: {e}"))
}

/// The host-side ceiling for `git <git_args>`: the verb's own
/// (`git_bounded::timeout_for_args`) plus a margin, so the local bound — which
/// starts before ssh even connects — always fires first and reports the
/// timeout; the host's then only reaps what is left. Pure.
pub(crate) fn host_timeout_secs(git_args: &[String]) -> u64 {
    crate::services::git_bounded::timeout_for_args(git_args).as_secs() + HOST_TIMEOUT_MARGIN_SECS
}

/// See [`host_timeout_secs`].
const HOST_TIMEOUT_MARGIN_SECS: u64 = 30;

/// [`remote_git_command`], run under the host's `timeout` when `host_secs` is
/// `Some`: `cd <path> && timeout -k 10 <secs> git <args…>` — plain words, so any
/// login shell runs it (`timeout` sends TERM to git's process group, then KILL
/// 10 s on). `None` is exactly [`remote_git_command`]. Pure.
pub fn bounded_remote_git_command(remote_path: &str, git_args: &[String], host_secs: Option<u64>) -> String {
    let Some(secs) = host_secs else {
        return remote_git_command(remote_path, git_args);
    };
    let mut s = format!("cd {} && timeout -k 10 {secs} git", shell_quote(remote_path));
    for a in git_args {
        s.push(' ');
        s.push_str(&shell_quote(a));
    }
    s
}

/// Run a single shell command on `spec`'s host over SSH (riding the shared
/// ControlMaster) and capture its `Output`. The command string is handed to the
/// remote `$SHELL -c`, so the caller MUST `shell_quote` any path/argument it
/// embeds. Used for cheap host capability probes.
pub fn run_remote_shell(spec: &RemoteSpec, command: &str) -> Result<std::process::Output, String> {
    remote_shell_command(spec, command)?
        .output()
        .map_err(|e| format!("failed to run command over ssh: {e}"))
}

/// The `ssh` command [`run_remote_shell`] runs, for a caller that bounds its
/// run itself (`services::git_bounded::run`). Same quoting duty on `command`.
pub fn remote_shell_command(spec: &RemoteSpec, command: &str) -> Result<std::process::Command, String> {
    let mut args = ssh_base_args(&spec.user, &spec.host, spec.port)?;
    args.push(command.to_string());
    let mut cmd = crate::paths::command_no_window("ssh");
    cmd.args(&args);
    Ok(cmd)
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
    run_remote_shell(spec, &remote_script_line(spec, script)?)
}

/// [`run_remote_script`], stopped at `timeout` (`git_bounded::run`: the ssh
/// child's subtree is killed and reaped) — for a script that must not hold its
/// caller on a stalled ControlMaster. Same duty on `script`.
pub fn run_remote_script_within(
    spec: &RemoteSpec,
    script: &str,
    timeout: std::time::Duration,
) -> Result<std::process::Output, String> {
    let mut cmd = remote_shell_command(spec, &remote_script_line(spec, script)?)?;
    let opts = crate::services::git_bounded::Opts { timeout: Some(timeout), no_precheck: true, ..Default::default() };
    match crate::services::git_bounded::run(&mut cmd, opts) {
        Ok(ran) => Ok(ran.output),
        Err(e) => Err(format!("failed to run a script over ssh: {e}")),
    }
}

/// The remote command line for [`run_remote_script`]: `cd <path> && { <script> }`.
fn remote_script_line(spec: &RemoteSpec, script: &str) -> Result<String, String> {
    validate_arg("remote path", &spec.remote_path)?;
    // The newline before `}` terminates the group's last command, so a script may end in
    // either `fi` or a trailing `;` without a syntax error either way.
    Ok(format!("cd {} && {{ {script}\n}}", shell_quote(&spec.remote_path)))
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

/// The argv that opens an **interactive** ssh login to `[user@]host[:port]`,
/// sharing the same multiplexing master socket (`ControlPath`) the terminal/agent
/// tabs use.
///
/// It is the program of a root-console **login PTY** (`pty_spawn` with `login:
/// ssh`, see `commands::credentials`), spawned as this argv directly — no shell
/// runs before or after it — when the user has turned **off** headless
/// connections: the password is entered directly in the visible terminal —
/// Tabtivity never handles it — and because the login shares `cm-%C` with
/// [`ssh_pty_args`], the pooled SFTP session, file browse, and git-over-ssh all
/// ride the authenticated master without a second prompt. On Unix this enables
/// `ControlMaster=auto`; on Windows multiplexing is unavailable so the login
/// simply opens its own connection. The control-socket dir is created here so ssh
/// can bind the master. [`interactive_exec_command`] builds on the same list.
pub(crate) fn interactive_login_args(
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

/// [`interactive_login_args`] with a command to **run** on the host instead of
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
mod tests;

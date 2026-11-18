//! [`SessionMux`] over the local tmux server: the `tmux_local` builders and
//! bodies, and the phone's attach/probe commands that lived in `pty_bridge`.
//! Each command's argv is exactly what its caller ran before the trait, so
//! the pins in `pty_bridge` and the scheduler still describe what runs.
//!
//! Shared code (it builds everywhere, so the argv tests run on Windows too);
//! only [`tmux_local::spawn_detached_with`] is Unix-only.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::Duration;

use super::{normalize_scrollback, ClientCmd, Key, MuxError, MuxKind, PaneInfo, SessionInfo, SessionMarks, SessionMux};
use app_core::sync::LockExt;
use crate::services::ssh_exec::{parse_tmux_ls, valid_tmux_session_name, TMUX_VT100_DIM, TMUX_VT100_DIM_MARK};
use crate::services::tmux_local;
use crate::terminal::PtyOptions;

/// The buffer a paste is loaded under; `paste-buffer -d` deletes it.
pub const PASTE_BUFFER: &str = concat!(crate::app_slug!(), "-schedule");

/// How long `list` waits for `tmux ls` (the phone catalog's deadline: a hung
/// tmux must not stall every load).
pub const LIST_TIMEOUT: Duration = Duration::from_secs(3);

/// The `display-message` format behind [`SessionMux::pane`].
const PANE_FORMAT: &str = "#{pane_dead}\t#{pane_pid}\t#{session_created}\t#{window_activity}\t#{window_width}\t#{window_height}";

/// The local tmux server. `Default` is production's: the app's server
/// (`tmux_local::socket_args`, `-L` only in server mode). [`TmuxMux::isolated`]
/// is a test's private server, `-L <socket> -f /dev/null`.
#[derive(Debug, Clone, Default)]
pub struct TmuxMux {
    socket: Option<String>,
    isolated: bool,
    /// Where a paste is staged for `load-buffer` (a long message does not fit
    /// a tmux command line). Unset: `<state_dir>/mobile-control/schedule-paste.txt`.
    paste_file: Option<PathBuf>,
}

impl TmuxMux {
    /// A private server on `socket`, ignoring the user's `~/.tmux.conf`.
    pub fn isolated(socket: impl Into<String>) -> Self {
        Self { socket: Some(socket.into()), isolated: true, paste_file: None }
    }

    pub fn with_paste_file(mut self, path: PathBuf) -> Self {
        self.paste_file = Some(path);
        self
    }

    /// The arguments that pick this mux's server, ahead of any tmux command.
    pub fn server_args(&self) -> Vec<String> {
        match &self.socket {
            Some(socket) => {
                let mut args = vec!["-L".to_string(), socket.clone()];
                if self.isolated {
                    args.extend(["-f".to_string(), "/dev/null".to_string()]);
                }
                args
            }
            None => tmux_local::socket_args(),
        }
    }

    /// A tmux client on this server, on the app's PATH and with no console
    /// window — `tmux_local::tmux_command` for the default mux. The PATH
    /// matters to the sidecar: a launchd/systemd user service inherits a bare
    /// one, where a bare `tmux` misses Homebrew's on a Mac or picks
    /// `/usr/bin/tmux` against a server a `~/.local/bin/tmux` started — and
    /// tmux refuses a client of another protocol version.
    pub fn command(&self) -> Command {
        let mut command = crate::paths::command_no_window("tmux");
        command.args(self.server_args());
        command
    }

    fn command_with<I, S>(&self, args: I) -> Command
    where
        I: IntoIterator<Item = S>,
        S: AsRef<std::ffi::OsStr>,
    {
        let mut command = self.command();
        command.args(args);
        command
    }

    /// `args` (a `tmux_local` argv on the app's server) moved onto this one.
    fn on_server(&self, args: Vec<String>) -> Vec<String> {
        if self.socket.is_none() {
            return args;
        }
        let base = tmux_local::socket_args();
        let rest = if args.starts_with(&base) { &args[base.len()..] } else { &args[..] };
        let mut moved = self.server_args();
        moved.extend(rest.iter().cloned());
        moved
    }

    /// The phone's attach client. The sidecar is a headless service with a
    /// bare inherited PATH, so tmux is resolved on the app's effective PATH
    /// (Homebrew's on a Mac, `~/.local/bin`) and the child gets that PATH too
    /// — the same tmux the desktop's sessions were started by, since tmux
    /// refuses a client of another protocol version. Absolute, so neither
    /// std's nor portable-pty's PATH lookup matters. `-u` forces UTF-8: with
    /// no LANG a tmux client replaces every `✓ ✗ ⚠ ● ⏺ └ ❯` the reading view
    /// classifies on. `TERM=vt100` has the cursor/clear capabilities tmux
    /// needs *without* `smcup`, so xterm's normal buffer keeps the replayed
    /// history scrollable; it describes only tmux's outer client.
    ///
    /// The default mux names the session bare and passes no `-L`, as the
    /// bridge always has.
    pub fn phone_attach(&self, name: &str) -> ClientCmd {
        let program = crate::paths::resolve_executable("tmux").unwrap_or_else(|| PathBuf::from("tmux"));
        let mut args = if self.socket.is_some() { self.server_args() } else { Vec::new() };
        args.extend(["-u".into(), "attach-session".into(), "-t".into(), name.to_string()]);
        let mut env = Vec::new();
        if let Some(path) = crate::paths::effective_path() {
            env.push(("PATH".to_string(), path.to_string_lossy().into_owned()));
        }
        env.push(("TERM".to_string(), "vt100".to_string()));
        env.push(("COLORTERM".to_string(), "truecolor".to_string()));
        ClientCmd { program, args, env }
    }

    /// The desktop's extra client on an existing session (`attach_argv`).
    pub fn desktop_attach(&self, name: &str) -> ClientCmd {
        ClientCmd {
            program: PathBuf::from("tmux"),
            args: self.on_server(tmux_local::attach_argv(name)),
            env: Vec::new(),
        }
    }

    /// `capture-pane` of up to `lines` of history. `-E -1` stops one line
    /// above the visible screen: without it the attach that follows redrew
    /// that same screen and the phone appended a second copy of it on every
    /// reconnect. `-J` joins tmux-side wrapped lines into the logical lines
    /// the process emitted; `-e` keeps SGR.
    pub fn capture_command(&self, name: &str, lines: usize) -> Command {
        self.command_with(["-u", "capture-pane", "-p", "-e", "-J", "-S", &format!("-{lines}"), "-E", "-1", "-t", name])
    }

    /// The tmux *window* geometry, which is what the pane is rendered at.
    pub fn window_size_command(&self, name: &str) -> Command {
        self.command_with(["-u", "display-message", "-p", "-t", name, "#{window_width}x#{window_height}"])
    }

    /// The read half of teaching this server that a `vt100` client can take
    /// dim text (`ssh_exec::TMUX_VT100_DIM`): prints `terminal-overrides`.
    pub fn dim_check_command(&self) -> Command {
        self.command_with(["show-options", "-s", TMUX_VT100_DIM.0])
    }

    /// The write half: **append** the entry (`set-option -as`), never set an
    /// index of the user's own option.
    pub fn keep_dim_command(&self) -> Command {
        let (option, value) = TMUX_VT100_DIM;
        self.command_with(["set-option", "-as", option, value])
    }

    pub fn screen_command(&self, name: &str) -> Command {
        self.command_with(tmux_local::local_tmux_screen_args(name))
    }

    pub fn list_command(&self) -> Command {
        self.command_with(tmux_local::local_tmux_ls_args())
    }

    pub fn has_command(&self, name: &str) -> Command {
        self.command_with(["has-session", "-t", &format!("={name}")])
    }

    pub fn pane_command(&self, name: &str) -> Command {
        self.command_with(["display-message", "-p", "-t", &target(name), PANE_FORMAT])
    }

    pub fn kill_command(&self, name: &str) -> Command {
        self.command_with(tmux_local::local_tmux_kill_args(name))
    }

    pub fn rename_command(&self, old: &str, new: &str) -> Command {
        self.command_with(tmux_local::local_tmux_rename_args(old, new))
    }

    pub fn env_command(&self, name: &str) -> Command {
        self.command_with(["show-environment", "-t", &format!("={name}")])
    }

    fn paste_file(&self) -> PathBuf {
        self.paste_file
            .clone()
            .unwrap_or_else(|| crate::storage::state_dir().join("mobile-control").join("schedule-paste.txt"))
    }

    /// Run a command whose failure is an error: `tmux <verb>: <stderr>`.
    fn run(&self, args: &[String]) -> Result<(), MuxError> {
        let out = output(self.command_with(args))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(MuxError::Refused(format!(
                "tmux {}: {}",
                args.first().map(String::as_str).unwrap_or(""),
                String::from_utf8_lossy(&out.stderr).trim()
            )))
        }
    }
}

/// How long a [`SessionMux::mcp_marks`] listing of the app's server is reused.
const MARKS_TTL: Duration = Duration::from_secs(3);

/// The app's server's last stamp listing, with when it was read.
static MARKS: std::sync::Mutex<Option<(std::time::Instant, SessionMarks)>> = std::sync::Mutex::new(None);

/// Forget the cached listing (a session was killed or renamed under it).
fn forget_marks() {
    *MARKS.lock_ok() = None;
}

impl TmuxMux {
    /// One `tmux ls` with the stamp column ([`tmux_local::mcp_marks_ls_args`]).
    fn read_mcp_marks(&self) -> Result<SessionMarks, MuxError> {
        let out = match crate::paths::output_within(self.command_with(tmux_local::mcp_marks_ls_args()), LIST_TIMEOUT) {
            Ok(out) => out,
            // No tmux on the app's PATH: no session was ever started in one.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(SessionMarks::default()),
            Err(error) => return Err(MuxError::Io(format!("tmux ls: {error}"))),
        };
        marks_answer(out.status.success(), &out.stdout, &out.stderr)
    }
}

/// One stamp-listing exit as an answer: no server is the answer "none".
pub fn marks_answer(success: bool, stdout: &[u8], stderr: &[u8]) -> Result<SessionMarks, MuxError> {
    if !success {
        let stderr = String::from_utf8_lossy(stderr);
        if says_no_server(&stderr) {
            return Ok(SessionMarks::default());
        }
        return Err(MuxError::Refused(format!("tmux ls failed: {}", stderr.trim())));
    }
    Ok(SessionMarks::from_rows(tmux_local::parse_mcp_marks(&String::from_utf8_lossy(stdout))))
}

/// `=<name>:` — the exact session, its current window.
fn target(name: &str) -> String {
    format!("={name}:")
}

/// A one-shot's output, stdin closed; a spawn failure reads `tmux: <error>`.
fn output(mut command: Command) -> Result<Output, MuxError> {
    command.stdin(std::process::Stdio::null());
    command.output().map_err(|e| MuxError::Io(format!("tmux: {e}")))
}

/// A failed command's stderr, read: no server, no such session, or the
/// refusal itself (`tmux <verb>: …`).
fn failure(verb: &str, stderr: &[u8]) -> MuxError {
    let stderr = String::from_utf8_lossy(stderr);
    if says_no_server(&stderr) {
        MuxError::NoServer
    } else if stderr.contains("can't find") {
        MuxError::NotFound
    } else {
        MuxError::Refused(format!("tmux {verb}: {}", stderr.trim()))
    }
}

/// Whether a failed tmux call is tmux saying there is no server — which is
/// how it says "zero sessions": the server exits with its last session, and a
/// client that finds none exits non-zero. The same wordings the desktop's own
/// tmux calls take for "already gone" (`tmux_local::kill_failure_is_already_gone`):
/// `no server running on …` (the socket is there, nobody behind it),
/// `error connecting to … (No such file or directory)` (no socket at all,
/// tmux ≥ 3.x), and the older `failed to connect to server`. Any other
/// failure — a permission error, an exhausted table, a server too busy to
/// accept — is tmux not answering.
pub fn says_no_server(stderr: &str) -> bool {
    stderr.contains("no server running")
        || stderr.contains("failed to connect to server")
        || (stderr.contains("error connecting to")
            && (stderr.contains("No such file or directory") || stderr.contains("Connection refused")))
}

/// One `tmux ls` exit (in [`tmux_local::local_tmux_ls_args`]'s format), read
/// as an answer or as a failure to get one: no server is the answer "none".
pub fn list_answer(success: bool, stdout: &[u8], stderr: &[u8]) -> Result<Vec<SessionInfo>, MuxError> {
    if !success {
        let stderr = String::from_utf8_lossy(stderr);
        if says_no_server(&stderr) {
            return Ok(Vec::new());
        }
        return Err(MuxError::Refused(format!("tmux ls failed: {}", stderr.trim())));
    }
    Ok(parse_tmux_ls(&String::from_utf8_lossy(stdout))
        .into_iter()
        .map(|row| SessionInfo {
            name: row.name,
            created: row.created,
            activity: row.activity,
            attached: row.attached,
            cwd: row.current_path,
            cmd: row.current_command,
        })
        .collect())
}

/// A [`PANE_FORMAT`] answer. Creation and activity must read; the rest is
/// what tmux could say.
pub fn parse_pane(stdout: &str) -> Option<PaneInfo> {
    let mut fields = stdout.trim().split('\t');
    let dead = fields.next()? == "1";
    let pid = fields.next()?.parse().ok();
    let created = fields.next()?.parse().ok()?;
    let activity = fields.next()?.parse().ok()?;
    let cols = fields.next().and_then(|v| v.parse().ok());
    let rows = fields.next().and_then(|v| v.parse().ok());
    Some(PaneInfo { dead, pid, created, activity, window: cols.zip(rows) })
}

/// The pid whose subtree a kill reaps: a live pane's only. A dead pane
/// (`remain-on-exit`) still reports the pid its command had, which the
/// kernel may since have handed to an unrelated process.
pub fn reap_target(pane: Option<PaneInfo>) -> Option<u32> {
    pane.filter(|pane| !pane.dead).and_then(|pane| pane.pid)
}

/// A `#{window_width}x#{window_height}` answer.
pub fn parse_window(stdout: &str) -> Option<(u16, u16)> {
    let (cols, rows) = stdout.trim().split_once('x')?;
    Some((cols.trim().parse().ok()?, rows.trim().parse().ok()?))
}

/// The `send-keys` calls that type `keys` into `name`, in order: each run of
/// named/control keys is one call (one write, so `C-x C-s` arrives as one
/// sequence), each literal its own `-l --` call.
pub fn send_keys_argvs(name: &str, keys: &[Key]) -> Vec<Vec<String>> {
    let head = || vec!["send-keys".to_string(), "-t".to_string(), target(name)];
    let mut calls: Vec<Vec<String>> = Vec::new();
    let mut pending: Option<Vec<String>> = None;
    for key in keys {
        match key {
            Key::Literal(text) => {
                calls.extend(pending.take());
                let mut call = head();
                call.extend(["-l".to_string(), "--".to_string(), text.clone()]);
                calls.push(call);
            }
            Key::Named(key) => pending.get_or_insert_with(head).push(key.clone()),
            Key::Ctrl(c) => pending.get_or_insert_with(head).push(format!("C-{c}")),
        }
    }
    calls.extend(pending);
    calls
}

/// `load-buffer` of the staged `file`, then `paste-buffer` into `name`: `-r`
/// keeps newlines as newlines (the default turns each into a submit), `-d`
/// drops the buffer, `-p` asks for the pane's bracketed paste.
pub fn paste_argvs(name: &str, file: &str, bracketed: bool) -> [Vec<String>; 2] {
    let load = ["load-buffer", "-b", PASTE_BUFFER, file].map(String::from).to_vec();
    let mut paste = ["paste-buffer", "-r", "-d", "-b", PASTE_BUFFER, "-t"].map(String::from).to_vec();
    paste.push(target(name));
    if bracketed {
        paste.insert(1, "-p".to_string());
    }
    [load, paste]
}

/// Teach this tmux server that a `vt100` client can take dim text, once:
/// when its `terminal-overrides` already holds a `vt100:dim=` entry (ours
/// from an earlier attach, or the user's own) nothing is written. A one-shot,
/// not a step of the attach: a tmux that refuses it still attaches.
pub fn keep_dim(show: Command, append: Command) -> Option<Output> {
    let mut show = show;
    let shown = show.output().ok()?;
    if shown.status.success() && String::from_utf8_lossy(&shown.stdout).contains(TMUX_VT100_DIM_MARK) {
        return Some(shown);
    }
    let mut append = append;
    append.output().ok()
}

/// The staged paste, readable by this user alone: it is the user's text and
/// lands in the state dir only for the length of one `load-buffer`.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)?.write_all(bytes)
}

#[cfg(unix)]
fn spawn_detached_on(mux: &TmuxMux, opts: &PtyOptions) -> Result<(), MuxError> {
    if !tmux_local::tmux_available() {
        return Err(MuxError::Unavailable("terminal: tmux is not installed".into()));
    }
    // A private socket is always started isolated (`-f /dev/null`).
    tmux_local::spawn_detached_with(opts, mux.socket.as_deref()).map_err(MuxError::Refused)
}

#[cfg(not(unix))]
fn spawn_detached_on(_mux: &TmuxMux, _opts: &PtyOptions) -> Result<(), MuxError> {
    Err(MuxError::Unavailable("terminal: tmux is not installed".into()))
}

impl SessionMux for TmuxMux {
    fn kind(&self) -> MuxKind {
        MuxKind::Tmux
    }

    fn available(&self) -> bool {
        tmux_local::tmux_available()
    }

    fn wrap(&self, opts: &mut PtyOptions) {
        if !tmux_local::tmux_available() {
            return;
        }
        let Some(session) = opts.tmux_session.clone() else {
            return;
        };
        let args = self.on_server(tmux_local::local_tmux_argv(&session, opts, false));
        opts.cmd = "tmux".to_string();
        opts.args = args;
        opts.mux_wrapped = true;
    }

    fn spawn_detached(&self, opts: &PtyOptions) -> Result<(), MuxError> {
        spawn_detached_on(self, opts)
    }

    fn attach_client(&self, name: &str, for_phone: bool) -> Result<ClientCmd, MuxError> {
        Ok(if for_phone { self.phone_attach(name) } else { self.desktop_attach(name) })
    }

    fn prepare_viewer(&self) {
        let _ = keep_dim(self.dim_check_command(), self.keep_dim_command());
    }

    fn list(&self) -> Result<Vec<SessionInfo>, MuxError> {
        match crate::paths::output_within(self.list_command(), LIST_TIMEOUT) {
            Ok(out) => list_answer(out.status.success(), &out.stdout, &out.stderr),
            // No tmux on the app's PATH: no session was ever started in one.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(error) => Err(MuxError::Io(format!("tmux ls: {error}"))),
        }
    }

    fn mcp_marks(&self) -> Result<SessionMarks, MuxError> {
        // Only the app's own server is cached: a private socket (a test) is
        // asked every time.
        if self.socket.is_some() {
            return self.read_mcp_marks();
        }
        let mut cached = MARKS.lock_ok();
        if let Some((at, marks)) = cached.as_ref() {
            if at.elapsed() < MARKS_TTL {
                return Ok(marks.clone());
            }
        }
        // The lock is held across the listing: concurrent restores of many tabs
        // wait on one `tmux ls` and then all read its answer.
        let marks = self.read_mcp_marks()?;
        *cached = Some((std::time::Instant::now(), marks.clone()));
        Ok(marks)
    }

    fn note_mcp_mark(&self, name: &str, mark: &str) {
        if self.socket.is_some() {
            return;
        }
        if let Some((_, marks)) = MARKS.lock_ok().as_mut() {
            marks.note(name, mark);
        }
    }

    fn has(&self, name: &str) -> Result<bool, MuxError> {
        Ok(output(self.has_command(name))?.status.success())
    }

    fn pane(&self, name: &str) -> Result<PaneInfo, MuxError> {
        let out = output(self.pane_command(name))?;
        if !out.status.success() {
            return Err(failure("display-message", &out.stderr));
        }
        parse_pane(&String::from_utf8_lossy(&out.stdout))
            .ok_or_else(|| MuxError::Refused("tmux display-message: unreadable answer".into()))
    }

    fn window(&self, name: &str) -> Result<(u16, u16), MuxError> {
        let out = output(self.window_size_command(name))?;
        if !out.status.success() {
            return Err(failure("display-message", &out.stderr));
        }
        parse_window(&String::from_utf8_lossy(&out.stdout))
            .ok_or_else(|| MuxError::Refused("tmux display-message: unreadable window size".into()))
    }

    fn screen(&self, name: &str) -> Result<String, MuxError> {
        let out = output(self.screen_command(name))?;
        if !out.status.success() {
            return Err(failure("capture-pane", &out.stderr));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    fn scrollback(&self, name: &str, lines: usize) -> Result<Vec<u8>, MuxError> {
        let out = output(self.capture_command(name, lines))?;
        if !out.status.success() {
            return Err(failure("capture-pane", &out.stderr));
        }
        if out.stdout.is_empty() {
            return Ok(Vec::new());
        }
        Ok(normalize_scrollback(out.stdout))
    }

    fn send_keys(&self, name: &str, keys: &[Key]) -> Result<(), MuxError> {
        for call in send_keys_argvs(name, keys) {
            self.run(&call)?;
        }
        Ok(())
    }

    fn paste(&self, name: &str, text: &str, bracketed: bool) -> Result<(), MuxError> {
        let file = self.paste_file();
        let staged = |e: std::io::Error| MuxError::Io(format!("stage submission: {e}"));
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir).map_err(staged)?;
        }
        write_private(&file, text.as_bytes()).map_err(staged)?;
        let [load, paste] = paste_argvs(name, &file.to_string_lossy(), bracketed);
        let pasted = self.run(&load).and_then(|()| self.run(&paste));
        let _ = std::fs::remove_file(&file);
        pasted
    }

    fn env_text(&self, name: &str) -> Option<String> {
        let shown = output(self.env_command(name))
            .ok()
            .filter(|out| out.status.success())
            .map(|out| String::from_utf8_lossy(&out.stdout).into_owned());
        let launcher = tmux_local::launcher_text(name);
        match (shown, launcher) {
            (None, None) => None,
            (shown, launcher) => Some(shown.into_iter().chain(launcher).collect::<Vec<_>>().join("\n")),
        }
    }

    /// The pane's process subtree is walked **before** the session ends (once
    /// the leader dies its children reparent and the tree is unreachable —
    /// `terminal::reap_child_subtree`), then `kill-session`, then the launcher
    /// script the session may have been started from is dropped.
    fn kill(&self, name: &str) -> Result<(), MuxError> {
        if let Some(pid) = reap_target(self.pane(name).ok()) {
            crate::terminal::reap_child_subtree(pid, crate::terminal::ReapMode::Graceful);
        }
        let out = output(self.kill_command(name))?;
        forget_marks();
        tmux_local::remove_launcher(name);
        if out.status.success() {
            return Ok(());
        }
        let detail = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if tmux_local::kill_failure_is_already_gone(&detail) {
            return Ok(());
        }
        Err(MuxError::Refused(format!("tmux kill-session: {detail}")))
    }

    fn rename(&self, old: &str, new: &str) -> Result<(), MuxError> {
        if !valid_tmux_session_name(new) {
            return Err(MuxError::Refused(format!("invalid session name '{new}'")));
        }
        let out = output(self.rename_command(old, new))?;
        forget_marks();
        if out.status.success() {
            Ok(())
        } else {
            Err(failure("rename-session", &out.stderr))
        }
    }

    /// The app's server keeps `tmux_local::kill_app_sessions` exactly (one
    /// `kill-session` per app session, then every launcher dropped); a
    /// private server goes through `list` and `kill`.
    fn kill_app_sessions(&self) -> Result<(), MuxError> {
        if self.socket.is_none() {
            forget_marks();
            return tmux_local::kill_app_sessions().map_err(MuxError::Refused);
        }
        super::kill_app_sessions_in(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    const NAME: &str = concat!(crate::app_slug!(), "-project--shell-test");

    fn args_of(command: &Command) -> Vec<String> {
        command.get_args().map(|a| a.to_string_lossy().into_owned()).collect()
    }

    fn on_app_server(args: Vec<String>) -> Vec<String> {
        let mut all = tmux_local::socket_args();
        all.extend(args);
        all
    }

    fn path_of(command: &Command) -> Option<&OsStr> {
        command.get_envs().find(|(key, _)| *key == "PATH").and_then(|(_, value)| value)
    }

    /// The default mux runs the `tmux_local` builders' argv on the app's
    /// server, through the app's PATH.
    #[test]
    fn the_default_mux_runs_the_tmux_local_argv() {
        let mux = TmuxMux::default();
        assert_eq!(mux.desktop_attach(NAME).args, tmux_local::attach_argv(NAME));
        assert_eq!(mux.desktop_attach(NAME).program, PathBuf::from("tmux"));
        assert_eq!(args_of(&mux.screen_command(NAME)), on_app_server(tmux_local::local_tmux_screen_args(NAME)));
        assert_eq!(args_of(&mux.list_command()), on_app_server(tmux_local::local_tmux_ls_args()));
        assert_eq!(args_of(&mux.kill_command(NAME)), on_app_server(tmux_local::local_tmux_kill_args(NAME)));
        assert_eq!(args_of(&mux.rename_command(NAME, "b")), on_app_server(tmux_local::local_tmux_rename_args(NAME, "b")));
        assert_eq!(args_of(&mux.has_command(NAME)), on_app_server(vec!["has-session".into(), "-t".into(), format!("={NAME}")]));
        let tmux = args_of(&tmux_local::tmux_command());
        assert_eq!(args_of(&mux.command()), tmux);
        let expected = crate::paths::extra_path_dirs()[0].clone();
        for command in [mux.list_command(), mux.screen_command(NAME), mux.capture_command(NAME, 5), mux.window_size_command(NAME)] {
            let path = path_of(&command).expect("tmux spawn carries PATH");
            assert_eq!(std::env::split_paths(path).next(), Some(expected.clone()));
        }
    }

    /// The phone's client: tmux on the app's PATH, UTF-8, `vt100`, the
    /// session named bare — what the bridge has always run.
    #[test]
    fn the_phone_attach_is_the_bridges_client() {
        let client = TmuxMux::default().phone_attach(NAME);
        assert_eq!(client.program.file_stem().and_then(OsStr::to_str), Some("tmux"));
        assert_eq!(client.args, ["-u", "attach-session", "-t", NAME]);
        let env = |key: &str| client.env.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone());
        assert_eq!(env("TERM").as_deref(), Some("vt100"));
        assert_eq!(env("COLORTERM").as_deref(), Some("truecolor"));
        if crate::paths::effective_path().is_some() {
            let path = env("PATH").expect("PATH");
            assert_eq!(std::env::split_paths(&path).next(), Some(crate::paths::extra_path_dirs()[0].clone()));
        }
        assert_eq!(TmuxMux::default().attach_client(NAME, true), Ok(client));
        assert_eq!(TmuxMux::default().attach_client(NAME, false), Ok(TmuxMux::default().desktop_attach(NAME)));
    }

    #[test]
    fn probes_keep_their_argv() {
        let mux = TmuxMux::default();
        assert_eq!(
            args_of(&mux.capture_command(NAME, 10)),
            on_app_server(["-u", "capture-pane", "-p", "-e", "-J", "-S", "-10", "-E", "-1", "-t", NAME].map(String::from).to_vec())
        );
        assert_eq!(
            args_of(&mux.window_size_command(NAME)),
            on_app_server(["-u", "display-message", "-p", "-t", NAME, "#{window_width}x#{window_height}"].map(String::from).to_vec())
        );
        assert_eq!(
            args_of(&mux.dim_check_command()),
            on_app_server(["show-options", "-s", TMUX_VT100_DIM.0].map(String::from).to_vec())
        );
        assert_eq!(
            args_of(&mux.keep_dim_command()),
            on_app_server(["set-option", "-as", TMUX_VT100_DIM.0, TMUX_VT100_DIM.1].map(String::from).to_vec())
        );
        assert_eq!(args_of(&mux.pane_command(NAME)), on_app_server(vec!["display-message".into(), "-p".into(), "-t".into(), format!("={NAME}:"), PANE_FORMAT.into()]));
    }

    /// An isolated mux puts every command — and a `tmux_local` argv — on its
    /// own server, ignoring the user's config.
    #[test]
    fn an_isolated_mux_moves_every_command_to_its_server() {
        let mux = TmuxMux::isolated("x");
        let private = ["-L", "x", "-f", "/dev/null"].map(String::from).to_vec();
        assert_eq!(args_of(&mux.command()), private);
        assert_eq!(&args_of(&mux.kill_command(NAME))[..4], &private[..]);
        let mut attach = private.clone();
        attach.extend(["-u", "attach-session", "-t", &format!("={NAME}")].map(String::from));
        assert_eq!(mux.desktop_attach(NAME).args, attach);
        assert_eq!(&mux.phone_attach(NAME).args[..4], &private[..]);
        let mut wrapped = tmux_local::socket_args();
        wrapped.extend(["new-session".to_string(), "-A".to_string()]);
        assert_eq!(mux.on_server(wrapped), [&private[..], &["new-session".to_string(), "-A".to_string()]].concat());
        // The default mux leaves a `tmux_local` argv as it is.
        let argv = vec!["a".to_string()];
        assert_eq!(TmuxMux::default().on_server(argv.clone()), argv);
    }

    /// `wrap` is `wrap_pty_options_local` for the default mux.
    #[test]
    fn wrap_is_the_local_wrap() {
        let opts: PtyOptions = serde_json::from_value(serde_json::json!({
            "id": "t", "cmd": "bash", "args": ["-c", "echo hi"], "cwd": "", "cols": 80, "rows": 24,
            "tmux_session": NAME,
        }))
        .expect("options");
        let (mut ours, mut theirs) = (opts.clone(), opts);
        TmuxMux::default().wrap(&mut ours);
        tmux_local::wrap_pty_options_local(&mut theirs);
        assert_eq!(ours.mux_wrapped, theirs.mux_wrapped);
        // Marked wrapped exactly where tmux runs (never on Windows).
        assert_eq!(ours.mux_wrapped, tmux_local::tmux_available());
        assert_eq!((ours.cmd, ours.args), (theirs.cmd, theirs.args));
    }

    #[test]
    fn keys_group_into_send_keys_calls() {
        let t = format!("={NAME}:");
        let calls = send_keys_argvs(NAME, &[Key::Ctrl('a'), Key::Ctrl('k'), Key::Literal("x".into()), Key::Named("Enter".into())]);
        assert_eq!(
            calls,
            vec![
                vec!["send-keys".to_string(), "-t".into(), t.clone(), "C-a".into(), "C-k".into()],
                vec!["send-keys".to_string(), "-t".into(), t.clone(), "-l".into(), "--".into(), "x".into()],
                vec!["send-keys".to_string(), "-t".into(), t.clone(), "Enter".into()],
            ]
        );
        assert_eq!(
            send_keys_argvs(NAME, &[Key::from_name("C-x"), Key::from_name("C-s")]),
            vec![vec!["send-keys".to_string(), "-t".into(), t, "C-x".into(), "C-s".into()]]
        );
        assert!(send_keys_argvs(NAME, &[]).is_empty());
    }

    #[test]
    fn a_paste_loads_then_pastes_raw() {
        let t = format!("={NAME}:");
        let [load, paste] = paste_argvs(NAME, "f", false);
        assert_eq!(load, ["load-buffer", "-b", PASTE_BUFFER, "f"]);
        assert_eq!(paste, ["paste-buffer", "-r", "-d", "-b", PASTE_BUFFER, "-t", &t]);
        let [_, paste] = paste_argvs(NAME, "f", true);
        assert_eq!(paste, ["paste-buffer", "-p", "-r", "-d", "-b", PASTE_BUFFER, "-t", &t]);
    }

    #[test]
    fn no_server_lists_nothing_and_any_other_failure_is_an_error() {
        for stderr in [
            "no server running on /tmp/tmux-1000/default",
            "error connecting to /tmp/tmux-1000/default (No such file or directory)",
            "error connecting to /tmp/tmux-1000/default (Connection refused)",
            "failed to connect to server: Connection refused",
        ] {
            assert_eq!(list_answer(false, b"", stderr.as_bytes()), Ok(Vec::new()), "{stderr}");
            assert_eq!(failure("x", stderr.as_bytes()), MuxError::NoServer);
        }
        for stderr in ["error connecting to /tmp/tmux-1000/default (Permission denied)", "server exited unexpectedly", "lost server", ""] {
            assert!(list_answer(false, b"", stderr.as_bytes()).is_err(), "{stderr:?}");
        }
        assert_eq!(failure("x", b"can't find session: s"), MuxError::NotFound);
        let rows = format!("{NAME}\t1\t100\t1\t200\tclaude\t/home/u/p\nbroken row\nwork\t1\t5\t0\t6\tbash\t/tmp\n");
        let listed = list_answer(true, rows.as_bytes(), b"").expect("listing");
        assert_eq!(
            listed[0],
            SessionInfo { name: NAME.into(), created: 100, activity: 200, attached: true, cwd: "/home/u/p".into(), cmd: "claude".into() }
        );
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[1].cwd, "/tmp");
    }

    #[test]
    fn pane_and_window_answers_parse() {
        assert_eq!(
            parse_pane("0\t4242\t100\t200\t180\t48\n"),
            Some(PaneInfo { dead: false, pid: Some(4242), created: 100, activity: 200, window: Some((180, 48)) })
        );
        assert_eq!(parse_pane("1\t\t100\t200\t\t").map(|p| (p.dead, p.pid, p.window)), Some((true, None, None)));
        assert_eq!(parse_pane("0\t1\tx\t200"), None);
        assert_eq!(parse_window("180x48\n"), Some((180, 48)));
        // A kill reaps a live pane's subtree, never a dead pane's stale pid.
        assert_eq!(reap_target(parse_pane("0\t4242\t100\t200\t180\t48")), Some(4242));
        assert_eq!(reap_target(parse_pane("1\t4242\t100\t200\t180\t48")), None);
        assert_eq!(reap_target(None), None);
        assert_eq!(parse_window("x48"), None);
    }
}

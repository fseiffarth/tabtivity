use std::{
    collections::{HashMap, VecDeque},
    io::{Read, Write},
    path::PathBuf,
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex, PoisonError,
    },
};
use app_core::sync::LockExt;

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tokio::sync::{mpsc, Notify};

use super::protocol::{
    TerminalControl, TerminalEvent, MAX_COLS, MAX_INPUT_FRAME, MAX_OUTPUT_QUEUE, MAX_ROWS,
    MIN_COLS, MIN_ROWS,
};
use super::{
    auth::AuthStore,
    discovery::{Catalog, CatalogCache},
    host_live::{HostSsh, PROBE_TIMEOUT},
};

/// One tab's viewer, as the registry knows it.
#[derive(Default)]
struct ViewerSlot {
    /// A newer viewer asked for the tab; this one leaves on its next tick.
    evicted: AtomicBool,
    /// The phone said its page is not in front of anyone
    /// (`TerminalControl::Visibility`). A phone that never says — an older
    /// bundle — counts as watching, which is what holding the slot used to
    /// mean for every viewer.
    hidden: AtomicBool,
}

type ViewerSlots = Arc<Mutex<HashMap<String, Arc<ViewerSlot>>>>;

#[derive(Clone, Default)]
pub struct TerminalRegistry {
    busy: ViewerSlots,
}

struct BusyGuard {
    name: String,
    slot: Arc<ViewerSlot>,
    busy: ViewerSlots,
}
impl BusyGuard {
    fn evicted(&self) -> bool {
        self.slot.evicted.load(Ordering::Acquire)
    }
    fn hidden(&self) -> bool {
        self.slot.hidden.load(Ordering::Acquire)
    }
    /// Record what the phone reported; `true` when that changed anything.
    fn set_visible(&self, visible: bool) -> bool {
        self.slot.hidden.swap(!visible, Ordering::AcqRel) == visible
    }
}
impl Drop for BusyGuard {
    fn drop(&mut self) {
        let mut busy = self.busy.lock_ok();
        // Only clear the slot if it is still ours: an evicting acquire may
        // already have installed its own slot under this name.
        if busy
            .get(&self.name)
            .is_some_and(|slot| Arc::ptr_eq(slot, &self.slot))
        {
            busy.remove(&self.name);
        }
    }
}

/// How long a reconnecting viewer waits for the previous one to notice it has
/// been evicted. The incumbent checks on its one-second authorization tick.
const EVICTION_WAIT: std::time::Duration = std::time::Duration::from_millis(2_500);

impl TerminalRegistry {
    pub fn is_busy(&self, name: &str) -> bool {
        self.busy.lock_ok().contains_key(name)
    }

    /// A phone has this tab open *and in front of someone*. `is_busy` alone
    /// stays true for a pocketed phone — the page is hidden, not gone, and its
    /// socket lives on for as long as throttled pings arrive (or `IDLE_TIMEOUT`
    /// after they stop) — which is exactly when its reader needs the "finished"
    /// or "needs your answer" notice that an attached tab does not get.
    pub fn is_watched(&self, name: &str) -> bool {
        self.busy
            .lock_ok()
            .get(name)
            .is_some_and(|slot| !slot.hidden.load(Ordering::Acquire))
    }

    /// Claims the tab, displacing an existing viewer if there is one.
    ///
    /// A phone that is backgrounded before its `detached` frame flushes leaves
    /// the slot held until the idle reaper (`IDLE_TIMEOUT`) fires, and the user
    /// was locked out of their own agent for minutes after glancing at another
    /// app. The newest viewer wins instead.
    async fn acquire(&self, name: &str) -> Result<BusyGuard, String> {
        let deadline = tokio::time::Instant::now() + EVICTION_WAIT;
        loop {
            {
                let mut busy = self.busy.lock_ok();
                match busy.get(name) {
                    None => {
                        let slot = Arc::new(ViewerSlot::default());
                        busy.insert(name.to_string(), slot.clone());
                        return Ok(BusyGuard {
                            name: name.into(),
                            slot,
                            busy: self.busy.clone(),
                        });
                    }
                    Some(incumbent) => incumbent.evicted.store(true, Ordering::Release),
                }
            }
            if tokio::time::Instant::now() >= deadline {
                return Err("session_busy".into());
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }
}

/// What a phone's terminal attaches to (`docs/mobile_remote_host_tabs_plan.md`).
/// The viewer registry is keyed by the session name either way.
#[derive(Debug, Clone)]
pub enum AttachTarget {
    /// A tmux session on this machine.
    Local { name: String },
    /// A tmux session on a remote project's host, reached through the
    /// desktop's ssh master for it and nothing else (`HostSsh`, raw).
    Host { name: String, ssh: HostSsh },
}

/// A CLI's sign on its screen that a message typed mid-turn still waits in
/// its queue: a row starting with `row_start` that holds `words`. While it
/// shows, Esc stops the turn and the CLI sends the queue at once; once the
/// turn has taken the message in (Claude does at its next tool call), the
/// sign is gone and an Esc would stop the turn that is to answer it — so Send
/// now presses only while it shows (`AttachTarget::send_now`).
#[derive(Debug, Clone, Copy)]
struct QueueHint {
    row_start: &'static str,
    words: &'static str,
}

/// Which CLIs Send now serves (probed 2026-10-25). Claude Code 2.1.310 holds
/// a mid-turn message until its next tool call and says so in its empty box.
/// Codex 0.164 and Copilot take one into the running turn at once, so there
/// is nothing to send now; OpenCode queues one but marks it nowhere a screen
/// can read. Any other CLI is unprobed.
fn queue_hint(family: &str) -> Option<QueueHint> {
    match family {
        "claude" => Some(QueueHint { row_start: "❯", words: "Press up to edit queued messages" }),
        _ => None,
    }
}

fn queue_hint_shown(screen: &str, hint: &QueueHint) -> bool {
    screen.lines().any(|row| row.starts_with(hint.row_start) && row.contains(hint.words))
}

/// The two one-shots the bridge runs beside the attach.
#[derive(Debug, Clone, Copy)]
enum Probe {
    Capture,
    WindowSize,
}

impl AttachTarget {
    fn name(&self) -> &str {
        match self {
            Self::Local { name } | Self::Host { name, .. } => name,
        }
    }

    /// The attach client the PTY runs.
    fn attach_command(&self) -> Result<CommandBuilder, String> {
        match self {
            Self::Local { name } => Ok(tmux_attach_command(name)),
            Self::Host { name, ssh } => host_attach_command(name, ssh),
        }
    }

    /// A one-shot's command. A host's runs under a deadline (`run`).
    fn probe_command(&self, probe: Probe) -> Result<Command, String> {
        match (self, probe) {
            (Self::Local { name }, Probe::Capture) => Ok(tmux_capture_command(name)),
            (Self::Local { name }, Probe::WindowSize) => Ok(tmux_window_size_command(name)),
            (Self::Host { name, ssh }, probe) => {
                let script = match probe {
                    Probe::Capture => crate::services::ssh_exec::host_tmux_capture_command(name, MOBILE_SCROLLBACK_LINES),
                    Probe::WindowSize => crate::services::ssh_exec::host_tmux_window_size_command(name),
                }
                .ok_or("invalid tmux session name")?;
                let args = crate::services::ssh_exec::host_mux_args(&ssh.spec, &ssh.control_path, false, &script)?;
                let mut command = crate::paths::command_no_window("ssh");
                command.args(args);
                Ok(command)
            }
        }
    }

    /// Send now: Esc straight into the pane (`send-keys`, so tmux's
    /// escape-time does not hold it back as an attach client's Esc is) while
    /// `hint` is on its screen; whether it went. A local check and press are
    /// two tmux calls milliseconds apart; a host's are one script on the host
    /// (`ssh_exec::host_tmux_send_now_command`), under the probe deadline.
    fn send_now(&self, hint: QueueHint) -> bool {
        match self {
            Self::Local { name } => {
                let mut capture = crate::services::tmux_local::tmux_command();
                capture.args(crate::services::tmux_local::local_tmux_screen_args(name));
                let Ok(screen) = capture.output() else { return false };
                if !screen.status.success() || !queue_hint_shown(&String::from_utf8_lossy(&screen.stdout), &hint) {
                    return false;
                }
                let mut press = crate::services::tmux_local::tmux_command();
                press.args(["send-keys", "-t", &format!("={name}:"), "Escape"]);
                press.status().is_ok_and(|status| status.success())
            }
            Self::Host { name, ssh } => {
                let Some(script) = crate::services::ssh_exec::host_tmux_send_now_command(name, hint.row_start, hint.words) else {
                    return false;
                };
                let Ok(args) = crate::services::ssh_exec::host_mux_args(&ssh.spec, &ssh.control_path, false, &script) else {
                    return false;
                };
                let mut command = crate::paths::command_no_window("ssh");
                command.args(args);
                crate::paths::output_within(command, PROBE_TIMEOUT)
                    .is_ok_and(|out| out.status.success() && String::from_utf8_lossy(&out.stdout).trim() == "sent")
            }
        }
    }

    /// Run a one-shot. A host's has a deadline: a hung host must not pin a
    /// blocking thread (the local tmux answers in milliseconds, as it always
    /// has).
    fn run(&self, probe: Probe) -> Option<std::process::Output> {
        let mut command = self.probe_command(probe).ok()?;
        match self {
            Self::Local { .. } => command.output().ok(),
            Self::Host { .. } => crate::paths::output_within(command, PROBE_TIMEOUT).ok(),
        }
    }
}

/// The attach for a host tab: `ssh -tt` through the master's literal socket
/// (`ssh_exec::host_mux_args`, which can only ride it, never dial), running
/// `tmux -u attach-session` in the remote's non-login shell (silent when the
/// session is gone: `ssh_exec::host_tmux_attach_command`). `TERM` is
/// set on the ssh process, which the mux client forwards to the remote PTY:
/// the same `vt100` as the local attach, for the same reason.
fn host_attach_command(name: &str, ssh: &HostSsh) -> Result<CommandBuilder, String> {
    let script = crate::services::ssh_exec::host_tmux_attach_command(name).ok_or("invalid tmux session name")?;
    let args = crate::services::ssh_exec::host_mux_args(&ssh.spec, &ssh.control_path, true, &script)?;
    // Absolute, like the local tmux (see `tmux_attach_command`).
    let program = crate::paths::resolve_executable("ssh").unwrap_or_else(|| std::path::PathBuf::from("ssh"));
    let mut command = CommandBuilder::new(program);
    if let Some(path) = crate::paths::effective_path() {
        command.env("PATH", path);
    }
    command.args(args);
    command.env("TERM", "vt100");
    command.env("COLORTERM", "truecolor");
    Ok(command)
}

fn tmux_attach_command(tmux_name: &str) -> CommandBuilder {
    // The sidecar is a headless service with a bare inherited PATH, so tmux is
    // resolved on Tabtivity's effective PATH (Homebrew's on a Mac, `~/.local/bin`)
    // and the child gets that PATH too — the same tmux the desktop's sessions
    // were started by, since tmux refuses a client of another protocol version.
    // Absolute, so neither std's nor portable-pty's PATH lookup semantics matter.
    // Deliberately NOT `command_no_window`: this is a ConPTY child on Windows,
    // and CREATE_NO_WINDOW would detach it from its pseudo-console.
    let tmux = crate::paths::resolve_executable("tmux")
        .unwrap_or_else(|| std::path::PathBuf::from("tmux"));
    let mut command = CommandBuilder::new(tmux);
    if let Some(path) = crate::paths::effective_path() {
        command.env("PATH", path);
    }
    // `-u` forces UTF-8. The sidecar is a headless systemd user service with no
    // guaranteed LANG/LC_CTYPE, and a non-UTF-8 tmux client replaces every
    // `✓ ✗ ⚠ ● ⏺ └ ❯` — the exact glyphs the reading view classifies on — so the
    // whole structured view would silently degrade to undifferentiated prose.
    command.args(["-u", "attach-session", "-t", tmux_name]);
    // The mobile host normally runs as a headless systemd user service and
    // therefore has no useful inherited TERM. `vt100` has the cursor/clear
    // capabilities tmux requires *without* `smcup`: xterm's normal buffer is
    // deliberately retained so the replayed tmux history is scrollable. This
    // describes only tmux's outer client; panes retain their own TERM.
    command.env("TERM", "vt100");
    command.env("COLORTERM", "truecolor");
    command
}

/// A tmux attach only redraws its current screen. Capture the pane first so a
/// phone's xterm buffer actually contains the shell history it is asked to
/// scroll. One number with the tmux retention Tabtivity sets on its sessions
/// (`ssh_exec::TMUX_HISTORY_LINES`) and the browser terminal's `scrollback`
/// (`PHONE_SCROLLBACK` in `mobile-web`): what tmux retains is what the replay
/// carries and what the phone can hold.
const MOBILE_SCROLLBACK_LINES: usize = crate::services::ssh_exec::TMUX_HISTORY_LINES as usize;

fn tmux_capture_command(tmux_name: &str) -> Command {
    // Tabtivity's effective PATH, as for the attach (see `tmux_attach_command`).
    let mut command = crate::services::tmux_local::tmux_command();
    command.args([
        "-u",
        "capture-pane",
        "-p",
        "-e",
        "-J",
        "-S",
        &format!("-{MOBILE_SCROLLBACK_LINES}"),
        // Stop one line above the visible screen. Without `-E`, capture ends at
        // the bottom of the *visible* pane, so the attach that follows redrew
        // that same screen and the phone appended a second copy of it on every
        // reconnect. `-J` joins tmux-side wrapped lines so the replay arrives as
        // the logical lines the process actually emitted.
        "-E",
        "-1",
        "-t",
        tmux_name,
    ]);
    command
}

/// The tmux *window* geometry, which is what the pane is actually rendered at.
fn tmux_window_size_command(tmux_name: &str) -> Command {
    let mut command = crate::services::tmux_local::tmux_command();
    command.args([
        "-u",
        "display-message",
        "-p",
        "-t",
        tmux_name,
        "#{window_width}x#{window_height}",
    ]);
    command
}

fn parse_window_size(raw: &str) -> Option<(u16, u16)> {
    let (cols, rows) = raw.trim().split_once('x')?;
    let cols: u16 = cols.trim().parse().ok()?;
    let rows: u16 = rows.trim().parse().ok()?;
    if !(MIN_COLS..=MAX_COLS).contains(&cols) || !(MIN_ROWS..=MAX_ROWS).contains(&rows) {
        return None;
    }
    Some((cols, rows))
}

/// A window wider than a client's screen is *panned* across it — under
/// `window-size largest` that was every smaller client, so a phone fitted to its
/// own viewport received a ~44-column moving slice of a ~180-column pane with
/// every line silently truncated (`latest`, the policy since tmux 3.2 —
/// `tmux_local::window_size_policy` — would shrink the desktop's window to the
/// phone's instead the moment it typed). The phone adopts the window geometry: its
/// xterm is an offscreen emulator whose column count never had to match the
/// physical screen, and the reading view re-wraps for display.
fn window_size(target: &AttachTarget) -> Option<(u16, u16)> {
    let output = target.run(Probe::WindowSize)?;
    if !output.status.success() {
        return None;
    }
    parse_window_size(&String::from_utf8_lossy(&output.stdout))
}

/// How often the window geometry is re-checked. The desktop can widen the window
/// at any time, which would silently reintroduce the pan.
const WINDOW_POLL: std::time::Duration = std::time::Duration::from_secs(5);

fn captured_scrollback(target: &AttachTarget) -> Vec<u8> {
    let Some(output) = target.run(Probe::Capture) else {
        return Vec::new();
    };
    if !output.status.success() || output.stdout.is_empty() {
        return Vec::new();
    }
    normalize_scrollback(output.stdout)
}

fn normalize_scrollback(output: Vec<u8>) -> Vec<u8> {
    // `capture-pane -p` writes Unix newlines. xterm's ordinary output uses
    // CRLF; without the CR, lines retain the previous column and a wrapped
    // history becomes unreadable. Preserve any CR that is already present.
    let mut history = Vec::with_capacity(output.len() + 1);
    let mut previous_was_cr = false;
    for byte in output {
        if byte == b'\n' && !previous_was_cr {
            history.push(b'\r');
        }
        history.push(byte);
        previous_was_cr = byte == b'\r';
    }
    if !history.ends_with(b"\n") {
        if !history.ends_with(b"\r") {
            history.push(b'\r');
        }
        history.push(b'\n');
    }
    history
}

/// How long one WebSocket frame may wait for the phone to take it.
///
/// A peer that vanished without a FIN — a cellular drop, a phone that slept
/// mid-transfer — leaves a socket that stays writable until the kernel's
/// retransmission timer gives up, which is minutes, and `send().await` parked
/// the whole select loop for that long: no authorization tick, no idle reaper,
/// no eviction check, while the tmux client and the tab's viewer slot stayed
/// held. A reconnecting phone then read `session_busy` against its own dead
/// socket. The phone drains a frame in milliseconds and pings every 20 s, so
/// one that has not gone out in this long has no reader behind it.
const WRITE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// The history replay goes out in frames of at most this many bytes, each
/// under its own `WRITE_TIMEOUT`. As one frame, ten thousand captured lines
/// (`MOBILE_SCROLLBACK_LINES`, easily a megabyte with colour) timed out on a
/// slow link before the phone had taken it, the attach returned without a
/// `closing` frame, and the phone reconnected into the same replay again.
const REPLAY_CHUNK: usize = 64 * 1024;

/// The replay as the frames that carry it: whole, in order, none over
/// `REPLAY_CHUNK`. The `replay` marker goes out once before the first; a
/// chunk boundary means nothing to the phone's emulator, which reads a byte
/// stream.
fn replay_frames(history: &[u8]) -> Vec<Vec<u8>> {
    history.chunks(REPLAY_CHUNK).map(<[u8]>::to_vec).collect()
}

/// The session's output on its way to the phone, bounded by
/// `MAX_OUTPUT_QUEUE` bytes.
///
/// A phone that reads slower than a flooding pane fills this. It used to be a
/// channel whose full state ended the reader thread and closed the socket
/// with 1013, and the phone then reconnected into a replay of the very flood
/// that had closed it. Then it shed its oldest bytes — on the theory that the
/// next redraw replaces them. It does not: tmux sends a client only the cells
/// it believes changed, so every dropped byte left cells on the phone's screen
/// that tmux never repainted (a long-gone diff interleaved with an agent's
/// question card), and a cut could land inside an escape sequence.
///
/// So a full queue *blocks* the reader instead. The PTY then stops draining,
/// the client's output backs up inside tmux, and tmux's own slow-client path
/// (`tty_block_maybe`) discards it and redraws the whole screen once the
/// client catches up — the one party that knows what the phone holds decides
/// what to resend. The link stays open throughout.
struct OutputQueue {
    state: Mutex<OutputState>,
    ready: Notify,
    /// Wakes a reader parked on a full queue: a chunk went out, or the queue
    /// was closed.
    space: Condvar,
}

#[derive(Default)]
struct OutputState {
    chunks: VecDeque<Vec<u8>>,
    bytes: usize,
    /// The reader has stopped: the PTY reached EOF or the queue was closed.
    closed: bool,
}

impl OutputQueue {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(OutputState::default()),
            ready: Notify::new(),
            space: Condvar::new(),
        })
    }

    /// Queue one chunk, waiting while the queue is past its byte budget.
    /// Blocking — call it from the reader thread only. `false` once the queue
    /// is closed: the chunk is dropped and the reader should stop.
    fn push(&self, chunk: Vec<u8>) -> bool {
        let mut state = self.state.lock_ok();
        while !state.closed && state.bytes > 0 && state.bytes + chunk.len() > MAX_OUTPUT_QUEUE {
            state = self.space.wait(state).unwrap_or_else(PoisonError::into_inner);
        }
        if state.closed {
            return false;
        }
        state.bytes += chunk.len();
        state.chunks.push_back(chunk);
        drop(state);
        self.ready.notify_one();
        true
    }

    /// Stop the queue: a parked `push` returns, and `pop` ends once drained.
    fn close(&self) {
        self.state.lock_ok().closed = true;
        self.ready.notify_one();
        self.space.notify_all();
    }

    /// The next chunk; `None` once the reader has stopped and nothing is left.
    async fn pop(&self) -> Option<Vec<u8>> {
        loop {
            {
                let mut state = self.state.lock_ok();
                if let Some(chunk) = state.chunks.pop_front() {
                    state.bytes -= chunk.len();
                    self.space.notify_all();
                    return Some(chunk);
                }
                if state.closed {
                    return None;
                }
            }
            // `notify_one` stores a permit when nobody waits, so a push that
            // lands between the check above and this await is not lost.
            self.ready.notified().await;
        }
    }
}

/// How long a viewer may go without sending anything before it is closed
/// (`idle_timeout`, retry allowed).
///
/// The phone pings every 20 s in the foreground — but Android Chrome and iOS
/// throttle a backgrounded page's timers to about once a minute, so at the old
/// 60 s the throttled ping landed just past the line and the next tick closed
/// the socket; the phone reconnected, and the reconnect replays the whole
/// capture-pane history, ten thousand lines, roughly once a minute for as long
/// as the app sat in the background. Three minutes rides out that cadence with
/// room to spare. The reaper's original job — freeing a slot a backgrounded
/// phone still held — is done by viewer eviction (`TerminalRegistry::acquire`)
/// and the write deadline above, so a longer window costs nothing.
const IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);

/// How often, at most, the desktop is told this viewer typed something
/// (`on_input`). The report says only that the session was commanded, so one per
/// burst is the whole signal: reporting per keystroke would spawn a control call
/// per character of a pasted prompt. Leading-edge, so the first byte of a burst
/// is reported at once — the desktop must have the stamp before the agent's
/// output arrives, or that output is classified as nobody's.
const INPUT_REPORT_INTERVAL: std::time::Duration = std::time::Duration::from_millis(750);

/// Whether this input frame opens a new burst, i.e. whether the desktop should
/// be told about it. `None` is the first frame of the attach, which always is.
fn input_report_due(last: Option<std::time::Instant>, now: std::time::Instant) -> bool {
    last.is_none_or(|at| now.duration_since(at) >= INPUT_REPORT_INTERVAL)
}

/// Whether an input frame is a bare Esc or Ctrl+C — the desktop's
/// `isInterruptInput`. Such a frame is reported whatever the burst window: it
/// can end a turn that fires no `Stop` (a dismissed question, an interrupted
/// tool), and only the report tells the desktop the turn is over.
fn is_interrupt_frame(bytes: &[u8]) -> bool {
    bytes == [MouseReportFilter::ESC] || bytes == [0x03]
}

/// Whether a close for `reason` tells the phone to come back. `replaced` means
/// another viewer took over; that client must not fight its way back in a
/// reconnect loop. `session_expired` retries through the phone's silent
/// re-login. `catalog_unavailable` is the bridge not being able to *ask*
/// whether the tab is still granted — nothing was revoked, so the phone
/// reconnects and the upgrade route decides; `access_revoked` is the catalog
/// answering no (the project's phone access switched off, the tab or its
/// session gone), and stays final, as does `host_offline` (a host tab whose
/// host the desktop no longer holds a master for: coming back needs the
/// desktop, not a retry).
fn closing_retries(reason: &str) -> bool {
    matches!(reason, "idle_timeout" | "session_expired" | "catalog_unavailable")
}

/// Why an attach whose output ended on its own may not be come back to, from
/// its client's exit code (`None`: not reaped in time, or a signal). A local
/// tab's end is left to the reconnect: the upgrade route asks the local tmux
/// and answers `410 session_gone` for a session that ended. A host tab's
/// upgrade cannot tell — with no window up, or on an HPC host, the host's tmux
/// is not asked and the master alone makes it available — so a bare close
/// sent the phone round a reconnect loop for good, each turn four ssh
/// sessions over the master (keeping it alive past `ControlPersist`, the one
/// thing the no-window rule exists to avoid). The exit code says which end it
/// was: `0` a detach or a session that exited while attached (the phone comes
/// back and the upgrade decides), `255` ssh itself (the master is gone), any
/// other the host-side script (`ssh_exec::host_tmux_attach_command`: no such
/// session, no tmux).
fn attach_end_reason(target: &AttachTarget, code: Option<u32>) -> Option<&'static str> {
    match (target, code) {
        (AttachTarget::Local { .. }, _) | (_, None | Some(0)) => None,
        (AttachTarget::Host { .. }, Some(255)) => Some("host_offline"),
        (AttachTarget::Host { .. }, Some(_)) => Some("session_gone"),
    }
}

/// The attach client's exit code once its output has ended: the PTY's EOF
/// comes as the client exits, so it is reaped within moments. `None` when it
/// is not (the drop's kill reaps it) or a signal ended it.
async fn exit_code_soon(child: &mut (dyn portable_pty::Child + Send + Sync)) -> Option<u32> {
    for _ in 0..50 {
        match child.try_wait() {
            Ok(Some(status)) => return status.signal().is_none().then(|| status.exit_code()),
            Ok(None) => tokio::time::sleep(std::time::Duration::from_millis(10)).await,
            Err(_) => return None,
        }
    }
    None
}

/// How long a lone `Esc` at the end of an input frame is held back in case the
/// rest of a mouse report follows in the next one (see [`MouseReportFilter`]).
/// Short enough that the Esc key does not feel late.
const ESC_HOLD: std::time::Duration = std::time::Duration::from_millis(60);

/// The longest unresolved prefix [`MouseReportFilter`] keeps; tmux itself gives
/// up on a report longer than 40 bytes.
const MOUSE_HELD_MAX: usize = 48;

/// What the bytes held so far make of a mouse report.
enum MouseVerdict {
    /// A complete report: dropped.
    Report,
    /// A prefix that could still become one.
    Partial,
    /// Not a report. `committed`: it already had the report's own shape (after
    /// `ESC [ <`, or `ESC [ M`), so what was held is dropped, not forwarded.
    Other { committed: bool },
}

/// Drops terminal mouse reports — X10 (`ESC [ M` and three bytes), SGR
/// (`ESC [ < b ; x ; y M|m`) and urxvt (`ESC [ b ; x ; y M`) — from the phone's
/// input before it reaches the pane. tmux binds a menu (split, respawn, kill)
/// to a right click in its root table, and `prefix None` does not stop a
/// click: a client that types reports could open a shell beside a fenced agent
/// (`docs/context/root_console.md`). The real PWA never sends one (its
/// terminal takes no input of its own), so nothing it does is lost.
///
/// A report may arrive split over frames, so a prefix is held until it is
/// resolved, never forwarded in part: tmux would otherwise finish it with the
/// next bytes it is given. A held lone `Esc` is the Esc key and goes out
/// after [`ESC_HOLD`] ([`Self::flush`]); the filter then still reads what
/// follows as the rest of an escape sequence, because tmux may still be
/// waiting for it (its `escape-time`) and would join them. Any other prefix
/// still unresolved by then is dropped: no key makes one.
#[derive(Default)]
struct MouseReportFilter {
    /// Starts with the `Esc` that opened the sequence.
    held: Vec<u8>,
    /// That `Esc` is out already (a flushed Esc key); it is never sent again.
    esc_sent: bool,
}

impl MouseReportFilter {
    const ESC: u8 = 0x1b;

    fn classify(&self) -> MouseVerdict {
        use MouseVerdict::*;
        let held = &self.held;
        if held.len() < 2 {
            return Partial;
        }
        if held[1] != b'[' {
            return Other { committed: false };
        }
        let Some(&third) = held.get(2) else { return Partial };
        let semis = |bytes: &[u8]| bytes.iter().filter(|&&b| b == b';').count();
        match third {
            b'M' => {
                // Three units follow: a byte each, or a UTF-8 sequence where the
                // terminal's mouse mode says so.
                let mut at = 3;
                let mut units = 0;
                while units < 3 {
                    let Some(&lead) = held.get(at) else { return Partial };
                    at += match lead {
                        0xf0..=0xff => 4,
                        0xe0..=0xef => 3,
                        0xc0..=0xdf => 2,
                        _ => 1,
                    };
                    units += 1;
                }
                if held.len() >= at { Report } else { Partial }
            }
            b'<' => {
                let rest = &held[3..];
                match rest.last() {
                    None => Partial,
                    Some(b'M' | b'm') if semis(&rest[..rest.len() - 1]) == 2
                        && rest[..rest.len() - 1].iter().all(|b| b.is_ascii_digit() || *b == b';') => Report,
                    Some(b) if b.is_ascii_digit() || *b == b';' => Partial,
                    Some(_) => Other { committed: true },
                }
            }
            b'0'..=b'9' => {
                let rest = &held[2..];
                match rest.last() {
                    Some(b) if b.is_ascii_digit() || *b == b';' => Partial,
                    Some(b'M') if semis(&rest[..rest.len() - 1]) == 2 => Report,
                    _ => Other { committed: false },
                }
            }
            _ => Other { committed: false },
        }
    }

    /// What `held` goes on as when it is not a report, or nothing when it is
    /// dropped.
    fn release(&mut self, out: &mut Vec<u8>, drop_it: bool) {
        if !drop_it {
            out.extend_from_slice(&self.held[usize::from(self.esc_sent)..]);
        }
        self.held.clear();
        self.esc_sent = false;
    }

    /// One input frame's bytes, less any mouse report and any prefix of one
    /// still undecided (held for the next frame).
    fn feed(&mut self, input: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(input.len());
        for &byte in input {
            if self.held.is_empty() {
                if byte == Self::ESC {
                    self.held.push(byte);
                } else {
                    out.push(byte);
                }
                continue;
            }
            self.held.push(byte);
            let verdict = if self.held.len() > MOUSE_HELD_MAX {
                MouseVerdict::Other { committed: true }
            } else {
                self.classify()
            };
            match verdict {
                MouseVerdict::Report => {
                    self.held.clear();
                    self.esc_sent = false;
                }
                MouseVerdict::Partial => {}
                MouseVerdict::Other { committed } => {
                    // The last byte is not part of it: it starts over.
                    self.held.pop();
                    self.release(&mut out, committed);
                    if byte == Self::ESC {
                        self.held.push(byte);
                    } else {
                        out.push(byte);
                    }
                }
            }
        }
        out
    }

    /// Whether the timer must run: bytes are held that may yet be a key.
    fn pending(&self) -> bool {
        !self.held.is_empty() && !(self.esc_sent && self.held.len() == 1)
    }

    /// The hold ran out: a lone `Esc` was the key; anything longer is no key.
    fn flush(&mut self) -> Vec<u8> {
        if self.held.len() == 1 && !self.esc_sent {
            self.esc_sent = true;
            return vec![Self::ESC];
        }
        if self.held.len() > 1 {
            self.held.clear();
            self.esc_sent = false;
        }
        Vec::new()
    }
}

/// What the AI switch keeps of an input frame to the tab, when it drops any of
/// it: an agent's frame while AI is off, unless the frame only interrupts or
/// steers (`ai_switch::filter_while_off`). `None` writes the frame as is.
fn ai_input_kept(ai: bool, state_dir: &std::path::Path, bytes: &[u8]) -> Option<Vec<u8>> {
    if !ai || !crate::services::ai_switch::is_off_at(&state_dir.join("settings.json")) {
        return None;
    }
    crate::services::ai_switch::filter_while_off(bytes)
}

/// The acknowledgement for the phone's `seq`-th input frame on this socket.
fn ack_frame(seq: u64) -> String {
    TerminalEvent::Ack { seq }.to_frame()
}

/// `true` once the frame went out; `false` when the socket is closed or the
/// peer stopped taking frames.
async fn deliver<S>(sink: &mut S, message: Message) -> bool
where
    S: futures_util::Sink<Message> + Unpin,
{
    matches!(
        tokio::time::timeout(WRITE_TIMEOUT, sink.send(message)).await,
        Ok(Ok(()))
    )
}

/// Every exit from the loop below must kill the tmux client and unblock the
/// reader thread. Two `?` operators used to return past that cleanup, leaking a
/// process, a PTY pair and a blocking-pool thread per malformed control frame —
/// enough of them exhausts the pool and wedges the terminal for every device.
struct PtySession {
    child: Box<dyn portable_pty::Child + Send + Sync>,
    output_task: tokio::task::JoinHandle<()>,
    window_task: tokio::task::JoinHandle<()>,
    output: Arc<OutputQueue>,
}

impl Drop for PtySession {
    fn drop(&mut self) {
        // A reader parked on a full queue never sees the PTY close: wake it
        // first, or its blocking thread outlives the attach.
        self.output.close();
        // Kill and reap. The reader is parked in a blocking read on a
        // cloned master fd, so it unblocks only once the child is gone and the
        // remaining write ends close; `abort()` cannot interrupt a blocking task.
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.output_task.abort();
        self.window_task.abort();
    }
}

pub async fn attach(
    socket: WebSocket,
    target: AttachTarget,
    registry: TerminalRegistry,
    auth: Arc<Mutex<AuthStore>>,
    token: String,
    state_dir: PathBuf,
    tab_id: String,
    catalog: Arc<Mutex<CatalogCache>>,
    // The tab runs an agent: its input obeys the AI switch.
    ai: bool,
    // Called on the leading edge of each burst of typing from this viewer (see
    // `INPUT_REPORT_INTERVAL`), and on every interrupt key with `true` (see
    // `is_interrupt_frame`). A callback rather than a desktop call of its
    // own, so this module keeps knowing nothing about the desktop socket.
    on_input: impl Fn(bool),
    // Called at each moment the screen was last, or is again, in front of
    // somebody: when the phone reports its page hidden or visible, and at
    // detach unless the page was hidden by then (see `host::terminal`).
    on_seen: impl Fn(),
) -> Result<(), String> {
    let tmux_name = target.name().to_string();
    let guard = registry.acquire(&tmux_name).await?;
    // Do this before the live attach starts redrawing. The browser receives it
    // before every PTY byte below, and tmux's clear/redraw then leaves these
    // lines in xterm's normal scrollback buffer above the live screen. The
    // geometry probe rides along in the same blocking hop.
    let probe_target = target.clone();
    let (history, initial_window) =
        tokio::task::spawn_blocking(move || (captured_scrollback(&probe_target), window_size(&probe_target)))
            .await
            .unwrap_or_default();
    // Open at the real window size so the very first redraw is already correctly
    // shaped, instead of a guaranteed mis-sized 24x80 frame on every attach.
    let (open_cols, open_rows) = initial_window.unwrap_or((80, 24));
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: open_rows,
            cols: open_cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    let command = target.attach_command()?;
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let master = pair.master;
    const OUTPUT_CHUNK: usize = 16 * 1024;
    let output = OutputQueue::new();
    let reader_queue = output.clone();
    let output_task = tokio::task::spawn_blocking(move || {
        loop {
            let mut bytes = vec![0; OUTPUT_CHUNK];
            let Ok(read) = reader.read(&mut bytes) else {
                break;
            };
            if read == 0 {
                break;
            }
            bytes.truncate(read);
            if !reader_queue.push(bytes) {
                break;
            }
        }
        reader_queue.close();
    });
    // The desktop can widen the window at any moment, which would silently start
    // panning the phone again. Poll it off the main loop so the fork never
    // stalls output delivery.
    let (window_tx, mut window_rx) = mpsc::channel::<(u16, u16)>(1);
    let window_target = target.clone();
    let window_task = tokio::spawn(async move {
        let mut last = initial_window;
        let mut tick = tokio::time::interval(WINDOW_POLL);
        tick.tick().await;
        loop {
            tick.tick().await;
            let probe = window_target.clone();
            let Ok(size) = tokio::task::spawn_blocking(move || window_size(&probe)).await else {
                break;
            };
            let Some(size) = size else { continue };
            if last == Some(size) {
                continue;
            }
            last = Some(size);
            if window_tx.send(size).await.is_err() {
                break;
            }
        }
    });
    let mut session = PtySession {
        child,
        output_task,
        window_task,
        output: output.clone(),
    };
    let (mut ws_tx, mut ws_rx) = socket.split();
    // An explicit replay boundary. The client keeps its last rendered screen
    // while reconnecting, so without this marker the replayed history and the
    // attach redraw were appended to it — one extra copy of the session per
    // reconnect, which on a flaky link made one agent turn look like several.
    let mut opening = vec![TerminalEvent::Replay.to_frame()];
    if let Some((cols, rows)) = initial_window {
        opening.push(TerminalEvent::Window { cols, rows }.to_frame());
    }
    // Last, and only ever read by a phone that knows the name: what this
    // bridge accepts beyond the base controls.
    opening.push(TerminalEvent::Features { visibility: true, send_now: true }.to_frame());
    // The AI switch, for an agent tab's composer: said at open only while
    // off, and on the tick below at every change.
    let settings_file = state_dir.join("settings.json");
    let mut ai_off = ai && crate::services::ai_switch::is_off_at(&settings_file);
    if ai_off {
        opening.push(TerminalEvent::AiSwitch { off: true }.to_frame());
    }
    for frame in opening {
        if !deliver(&mut ws_tx, Message::Text(frame.into())).await {
            return Ok(());
        }
    }
    for chunk in replay_frames(&history) {
        if !deliver(&mut ws_tx, Message::Binary(chunk.into())).await {
            return Ok(());
        }
    }
    let mut authorization_tick = tokio::time::interval(std::time::Duration::from_secs(1));
    let mut tick = 0u32;
    let mut last_client_message = std::time::Instant::now();
    // When this viewer's typing was last reported to the desktop.
    let mut last_input_report: Option<std::time::Instant> = None;
    // Binary input frames written to the PTY on this socket; the phone counts
    // the ones it sent the same way, and each `ack` names this count.
    let mut input_frames: u64 = 0;
    // Mouse reports never reach the pane (`MouseReportFilter`); `flush_at` is
    // when a held Esc goes out as the key it is.
    let mut mouse = MouseReportFilter::default();
    let mut flush_at: Option<tokio::time::Instant> = None;
    // The held Esc came as a frame of its own: the Esc key, an interrupt once
    // it goes out.
    let mut held_esc_key = false;
    // The phone spoke: its session slides (`auth::SESSION_IDLE`). Every frame
    // it sends, not the tick — a tick is the sidecar checking, not the phone.
    let touch = |auth: &Arc<Mutex<AuthStore>>| {
        auth.lock_ok().touch(&token);
    };
    let result: Result<(), String> = loop {
        tokio::select! {
            _ = authorization_tick.tick() => {
                if guard.evicted() { break Err("replaced".into()); }
                if ai {
                    let now_off = crate::services::ai_switch::is_off_at(&settings_file);
                    if now_off != ai_off {
                        ai_off = now_off;
                        if !deliver(&mut ws_tx, Message::Text(TerminalEvent::AiSwitch { off: now_off }.to_frame().into())).await { break Ok(()); }
                    }
                }
                if last_client_message.elapsed() > IDLE_TIMEOUT {
                    break Err("idle_timeout".into());
                }
                // Eviction and idling stay on the 1-second tick above. The
                // session/catalog re-check forks `tmux ls` (through the 1s-TTL
                // cache) and walks the session snapshots, so it runs on every
                // fifth tick: revocation — a rare, deliberate act — is enforced
                // within 5 seconds instead of 1, for a fifth of the steady
                // per-viewer fork rate.
                if tick.is_multiple_of(5) {
                    // The session's phone: a session never changes device, so
                    // this is the phone the upgrade route checked, and the
                    // per-phone list is re-read for it below.
                    let (device, key) = {
                        let mut auth = auth.lock_ok();
                        (auth.authenticate(&token), auth.host_key().to_vec())
                    };
                    // Two different facts, told apart on the wire: a session
                    // that ran out (a sidecar restart, the idle window) is the
                    // phone's to renew silently and come back; a tab the
                    // catalog no longer grants is not.
                    let Some(device) = device else { break Err("session_expired".into()); };
                    // Off the async workers: a load past the TTL forks `tmux ls`
                    // and waits on the catalog mutex behind whoever else does.
                    let loaded = {
                        let (catalog, state_dir) = (catalog.clone(), state_dir.clone());
                        tokio::task::spawn_blocking(move || {
                            catalog.lock_ok().load(&state_dir, &key)
                        })
                        .await
                    };
                    if let Err(reason) = recheck(loaded.ok().and_then(Result::ok), &device, &tab_id, &tmux_name) {
                        break Err(reason.into());
                    }
                }
                tick = tick.wrapping_add(1);
            }
            _ = async {
                match flush_at {
                    Some(at) => tokio::time::sleep_until(at).await,
                    None => std::future::pending::<()>().await,
                }
            } => {
                flush_at = None;
                let held = mouse.flush();
                if !held.is_empty() {
                    let held = ai_input_kept(ai, &state_dir, &held).unwrap_or(held);
                    if !held.is_empty() && (writer.write_all(&held).is_err() || writer.flush().is_err()) { break Ok(()); }
                    // The Esc key the frame path held back: told here, once
                    // it reached the pane.
                    if !held.is_empty() {
                        last_input_report = Some(std::time::Instant::now());
                        on_input(std::mem::take(&mut held_esc_key));
                    }
                }
            }
            Some((cols, rows)) = window_rx.recv() => {
                if !deliver(&mut ws_tx, Message::Text(TerminalEvent::Window { cols, rows }.to_frame().into())).await { break Ok(()); }
            }
            chunk = output.pop() => match chunk {
                Some(bytes) => if !deliver(&mut ws_tx, Message::Binary(bytes.into())).await { break Ok(()); },
                // The pane's output ended: tmux detached the client, or the
                // session is gone (for a host tab, said outright: see
                // `attach_end_reason`).
                None => match attach_end_reason(&target, exit_code_soon(session.child.as_mut()).await) {
                    Some(reason) => break Err(reason.into()),
                    None => break Ok(()),
                },
            },
            incoming = ws_rx.next() => match incoming {
                Some(Ok(Message::Binary(bytes))) => {
                    last_client_message = std::time::Instant::now();
                    touch(&auth);
                    if bytes.len() > MAX_INPUT_FRAME { break Err("input_frame_too_large".into()); }
                    let interrupt = is_interrupt_frame(&bytes);
                    // Before anything else reads the frame: a mouse report is
                    // dropped here (acked, as the AI switch's drops are), so it
                    // neither reaches tmux nor counts as the phone commanding it.
                    let bytes = mouse.feed(&bytes);
                    held_esc_key = interrupt && mouse.pending();
                    flush_at = mouse.pending().then(|| tokio::time::Instant::now() + ESC_HOLD);
                    if bytes.is_empty() {
                        input_frames += 1;
                        if !deliver(&mut ws_tx, Message::Text(ack_frame(input_frames).into())).await { break Ok(()); }
                        continue;
                    }
                    // The AI switch: nothing typed reaches an agent while it is
                    // off. The frame is still acked — it was handled, by
                    // dropping it — and the phone is told why.
                    if let Some(kept) = ai_input_kept(ai, &state_dir, &bytes) {
                        // `AiOff` first: the phone marks what the ack after
                        // it covers as not delivered, keeping its words. A
                        // Ctrl+C in the frame still goes in.
                        if !kept.is_empty() && (writer.write_all(&kept).is_err() || writer.flush().is_err()) { break Ok(()); }
                        input_frames += 1;
                        if !deliver(&mut ws_tx, Message::Text(TerminalEvent::AiOff.to_frame().into())).await { break Ok(()); }
                        if !deliver(&mut ws_tx, Message::Text(ack_frame(input_frames).into())).await { break Ok(()); }
                        continue;
                    }
                    if writer.write_all(&bytes).is_err() || writer.flush().is_err() { break Ok(()); }
                    // After the write, so a frame that never reached the PTY is
                    // never reported as having commanded it — and never acked.
                    input_frames += 1;
                    if !deliver(&mut ws_tx, Message::Text(ack_frame(input_frames).into())).await { break Ok(()); }
                    if interrupt || input_report_due(last_input_report, last_client_message) {
                        last_input_report = Some(last_client_message);
                        on_input(interrupt);
                    }
                }
                Some(Ok(Message::Text(text))) => {
                    last_client_message = std::time::Instant::now();
                    touch(&auth);
                    // `break`, never `?`: returning here would skip the cleanup
                    // that PtySession::drop performs.
                    let Ok(control) = serde_json::from_str::<TerminalControl>(&text) else {
                        break Err("invalid_terminal_control".into());
                    };
                    match control {
                        TerminalControl::Resize { cols, rows } => {
                            if !(MIN_COLS..=MAX_COLS).contains(&cols) || !(MIN_ROWS..=MAX_ROWS).contains(&rows) { break Err("invalid_terminal_size".into()); }
                            if master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).is_err() {
                                break Err("resize_failed".into());
                            }
                        }
                        TerminalControl::Ping => { if !deliver(&mut ws_tx, Message::Text(TerminalEvent::Pong.to_frame().into())).await { break Ok(()); } }
                        TerminalControl::Detached => break Ok(()),
                        TerminalControl::Ready => {}
                        // Both edges are a moment the reader's eyes were on the
                        // screen — the last one before it went dark, the first
                        // after it came back — so both stamp the tab read, and
                        // what finishes in between stays unread.
                        TerminalControl::Visibility { visible } => {
                            if guard.set_visible(visible) { on_seen(); }
                        }
                        // Nothing goes in while the AI switch is off: the
                        // queue Esc would release is the agent's work.
                        TerminalControl::SendNow { family } => {
                            let sent = match queue_hint(&family) {
                                Some(hint) if !ai_off => {
                                    let target = target.clone();
                                    tokio::task::spawn_blocking(move || target.send_now(hint)).await.unwrap_or(false)
                                }
                                _ => false,
                            };
                            // An Esc the pane got, told as the phone's own is.
                            if sent {
                                last_input_report = Some(std::time::Instant::now());
                                on_input(true);
                            }
                            if !deliver(&mut ws_tx, Message::Text(TerminalEvent::SendNow { sent }.to_frame().into())).await { break Ok(()); }
                        }
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break Ok(()),
                _ => {}
            }
        }
    };
    // Tell the phone *why*. Without this every rejection arrived as a bare
    // close and was rendered as "reconnecting…" forever, including revocation.
    if let Err(reason) = &result {
        let frame = TerminalEvent::Closing {
            reason: reason.clone(),
            retry: closing_retries(reason),
        }
        .to_frame();
        let _ = deliver(&mut ws_tx, Message::Text(frame.into())).await;
    }
    // Detaching is the last moment the screen was in front of somebody —
    // unless the page had already gone dark, and that moment was stamped then.
    if !guard.hidden() {
        on_seen();
    }
    // Kill first, then release the remaining write ends so the reader unblocks.
    drop(session);
    drop(writer);
    drop(master);
    result
}

/// The periodic re-check's verdict on one catalog load, for the phone paired
/// as `device`: the tab is still granted to it, or the close reason. A catalog
/// that could not be read at all is not a revocation: that close retries
/// (`closing_retries`). A tmux that merely could not be asked never gets this
/// far — the cache carries its last answer forward — so a tab the catalog no
/// longer lists for this phone (its switch off, or a per-phone list narrowed
/// past it) is the catalog saying no. A host tab it still lists, on the same
/// session, that has gone unavailable closes as `host_offline` when the last
/// round found no master for its host, and as `session_gone` when it found
/// the master but the host's tmux no longer lists the session.
fn recheck(loaded: Option<Catalog>, device: &str, tab_id: &str, tmux_name: &str) -> Result<(), &'static str> {
    let Some(catalog) = loaded.map(|catalog| catalog.for_device(device)) else {
        return Err("catalog_unavailable");
    };
    if catalog.grants(tab_id, tmux_name) {
        return Ok(());
    }
    match catalog.tab(tab_id) {
        Some((_, tab)) if tab.place.on_host() && tab.tmux_name == tmux_name => {
            Err(if tab.place.host_ssh().is_some() { "session_gone" } else { "host_offline" })
        }
        _ => Err("access_revoked"),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        normalize_scrollback, parse_window_size, queue_hint, queue_hint_shown, tmux_attach_command, tmux_capture_command,
        tmux_window_size_command, MOBILE_SCROLLBACK_LINES,
    };
    use super::{
        ack_frame, closing_retries, deliver, input_report_due, is_interrupt_frame, replay_frames, OutputQueue, IDLE_TIMEOUT,
        INPUT_REPORT_INTERVAL, REPLAY_CHUNK, WRITE_TIMEOUT,
    };
    use super::MouseReportFilter;
    use crate::services::mobile_control::protocol::{TerminalControl, TerminalEvent, MAX_OUTPUT_QUEUE};
    use axum::extract::ws::Message;
    use std::{
        ffi::OsStr,
        pin::Pin,
        task::{Context, Poll},
    };

    /// Narrowing a scope's per-phone list past the phone holding the terminal
    /// detaches it like switching access off does; the listed phone keeps it.
    #[test]
    fn narrowing_the_phone_list_detaches_an_open_terminal() {
        use crate::services::mobile_control::discovery::{fixture_scope, Catalog};
        let with = |devices: Option<Vec<String>>| Catalog { projects: vec![fixture_scope("t", "tmux-t", devices)] };
        assert_eq!(super::recheck(Some(with(None)), "d1", "t", "tmux-t"), Ok(()));
        assert_eq!(super::recheck(Some(with(Some(vec!["d1".into()]))), "d1", "t", "tmux-t"), Ok(()));
        assert_eq!(super::recheck(Some(with(Some(vec!["d2".into()]))), "d1", "t", "tmux-t"), Err("access_revoked"));
        assert_eq!(super::recheck(Some(with(Some(vec![]))), "d1", "t", "tmux-t"), Err("access_revoked"));
        assert_eq!(super::recheck(None, "d1", "t", "tmux-t"), Err("catalog_unavailable"));
    }

    /// A host tab's three commands ride the master's literal socket through
    /// `host_mux_args` (no ssh_config, `-F none`): `ssh -tt` for the attach with `TERM=vt100` on the
    /// ssh process, `ssh -T` for the capture and the window size, the tmux
    /// script last after `--`. A local tab's stay tmux here.
    #[test]
    fn a_host_target_runs_its_commands_through_the_masters_socket() {
        use super::{AttachTarget, Probe};
        use crate::services::mobile_control::host_live::HostSsh;
        let name = concat!(crate::app_slug!(), "-p--agent-0123456789");
        let socket = std::env::temp_dir().join("cm-host");
        let target = AttachTarget::Host {
            name: name.into(),
            ssh: HostSsh {
                spec: Box::new(serde_json::from_value(serde_json::json!({ "user": "alice", "host": "h.example", "port": 2200, "remote_path": "/srv/p" })).unwrap()),
                control_path: socket.clone(),
            },
        };
        let literal = format!("ControlPath={}", socket.to_string_lossy());
        let attach = target.attach_command().expect("attach");
        assert_eq!(attach.get_env("TERM"), Some(OsStr::new("vt100")));
        let argv: Vec<String> = attach.get_argv().iter().map(|a| a.to_string_lossy().into_owned()).collect();
        assert!(std::path::Path::new(&argv[0]).file_stem().is_some_and(|stem| stem == "ssh"), "{argv:?}");
        assert_eq!(&argv[1..4], ["-F", "none", "-tt"]);
        assert!(argv.contains(&literal) && argv.contains(&"ProxyCommand=false".to_string()), "{argv:?}");
        assert_eq!(&argv[argv.len() - 2..], ["--".to_string(), crate::services::ssh_exec::host_tmux_attach_command(name).unwrap()]);
        for (probe, script) in [
            (Probe::Capture, crate::services::ssh_exec::host_tmux_capture_command(name, MOBILE_SCROLLBACK_LINES).unwrap()),
            (Probe::WindowSize, crate::services::ssh_exec::host_tmux_window_size_command(name).unwrap()),
        ] {
            let command = target.probe_command(probe).expect("one-shot");
            let args: Vec<String> = command.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
            assert_eq!(&args[..3], ["-F", "none", "-T"]);
            assert!(args.contains(&literal));
            assert_eq!(args.last(), Some(&script));
        }
        // A name the catalog would never hand over is refused, not quoted.
        let AttachTarget::Host { ssh, .. } = target else { unreachable!() };
        let hostile = AttachTarget::Host { name: "x'; id; '".into(), ssh };
        assert!(hostile.attach_command().is_err());
        assert!(hostile.probe_command(Probe::Capture).is_err());

        let local = AttachTarget::Local { name: name.into() };
        let argv = local.attach_command().expect("attach").get_argv().iter().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>();
        assert!(std::path::Path::new(&argv[0]).file_stem().is_some_and(|stem| stem == "tmux"), "{argv:?}");
    }

    /// A host attach that ends on its own says why, so the phone stops instead
    /// of reconnecting forever to a tab its upgrade still calls available:
    /// ssh's own failure (255) is `host_offline`, the host-side script's (no
    /// such session, no tmux) `session_gone`, both final; a clean end (a
    /// detach, a session that exited while attached) and an unknown one are
    /// left to the reconnect, as is every local end.
    #[test]
    fn a_host_attach_that_ends_on_its_own_says_why() {
        use super::{attach_end_reason, AttachTarget};
        use crate::services::mobile_control::host_live::HostSsh;
        let host = AttachTarget::Host {
            name: "s".into(),
            ssh: HostSsh {
                spec: Box::new(serde_json::from_value(serde_json::json!({ "host": "h.example", "remote_path": "/srv/p" })).unwrap()),
                control_path: std::env::temp_dir().join("cm-h"),
            },
        };
        assert_eq!(attach_end_reason(&host, Some(255)), Some("host_offline"));
        assert_eq!(attach_end_reason(&host, Some(1)), Some("session_gone"));
        assert_eq!(attach_end_reason(&host, Some(127)), Some("session_gone"));
        assert_eq!(attach_end_reason(&host, Some(0)), None);
        assert_eq!(attach_end_reason(&host, None), None);
        for reason in ["host_offline", "session_gone"] {
            assert!(!closing_retries(reason), "{reason}");
        }
        let local = AttachTarget::Local { name: "s".into() };
        for code in [None, Some(0), Some(1), Some(255)] {
            assert_eq!(attach_end_reason(&local, code), None, "{code:?}");
        }
    }

    /// The exit code is read off the attach client once its output ended.
    #[cfg(unix)]
    #[tokio::test]
    async fn the_attach_clients_exit_code_is_read_once_it_ends() {
        use portable_pty::{CommandBuilder, PtySize};
        let pair = portable_pty::native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "exit 3"]);
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let mut code = None;
        for _ in 0..100 {
            code = super::exit_code_soon(child.as_mut()).await;
            if code.is_some() {
                break;
            }
        }
        assert_eq!(code, Some(3));
    }

    /// A host tab still listed on the same session but gone unavailable — its
    /// master ended — closes as `host_offline`, final like a revocation.
    #[test]
    fn a_host_tab_whose_master_went_away_closes_as_host_offline() {
        use crate::services::mobile_control::discovery::{fixture_scope, Catalog, TabPlace};
        let host = |available: bool| {
            let mut scope = fixture_scope("t", "tmux-t", None);
            scope.tabs[0].public.available = available;
            scope.tabs[0].place = TabPlace::Host {
                spec: Box::new(serde_json::from_value(serde_json::json!({ "host": "h.example", "remote_path": "/srv/p" })).unwrap()),
                control_path: None,
            };
            Catalog { projects: vec![scope] }
        };
        assert_eq!(super::recheck(Some(host(true)), "d1", "t", "tmux-t"), Ok(()));
        assert_eq!(super::recheck(Some(host(false)), "d1", "t", "tmux-t"), Err("host_offline"));
        assert_eq!(super::recheck(Some(host(false)), "d1", "t", "tmux-other"), Err("access_revoked"));
        assert!(!closing_retries("host_offline"));
        // The master is there, but the host's tmux no longer lists the
        // session: it ended, the host did not go away.
        let mut ended = host(false);
        ended.projects[0].tabs[0].place = TabPlace::Host {
            spec: Box::new(serde_json::from_value(serde_json::json!({ "host": "h.example", "remote_path": "/srv/p" })).unwrap()),
            control_path: Some(std::env::temp_dir().join("cm-h")),
        };
        assert_eq!(super::recheck(Some(ended), "d1", "t", "tmux-t"), Err("session_gone"));
        let mut local = fixture_scope("t", "tmux-t", None);
        local.tabs[0].public.available = false;
        assert_eq!(super::recheck(Some(Catalog { projects: vec![local] }), "d1", "t", "tmux-t"), Err("access_revoked"));
    }

    #[test]
    fn the_desktop_hears_the_first_keystroke_of_a_burst_and_not_the_rest() {
        let start = std::time::Instant::now();
        // Nothing reported yet: the attach's first input always counts.
        assert!(input_report_due(None, start));
        // The rest of the burst is the same fact, already known.
        assert!(!input_report_due(
            Some(start),
            start + INPUT_REPORT_INTERVAL / 2
        ));
        // Typing again after the window is a new burst — and the desktop may
        // have forgotten the tab in between (a respawn clears the stamp).
        assert!(input_report_due(Some(start), start + INPUT_REPORT_INTERVAL));
    }

    #[test]
    fn a_bare_esc_or_ctrl_c_is_an_interrupt_and_nothing_else_is() {
        assert!(is_interrupt_frame(b"\x1b"));
        assert!(is_interrupt_frame(b"\x03"));
        // An arrow key, Alt+x, a prompt ending in Enter: input, not an interrupt.
        assert!(!is_interrupt_frame(b"\x1b[A"));
        assert!(!is_interrupt_frame(b"\x1bx"));
        assert!(!is_interrupt_frame(b"go on\r"));
        assert!(!is_interrupt_frame(b""));
    }

    #[tokio::test]
    async fn a_reconnecting_viewer_evicts_the_previous_one() {
        use super::TerminalRegistry;
        let registry = TerminalRegistry::default();
        let first = registry.acquire(concat!(crate::app_slug!(), "-p--agent-1")).await.expect("first");
        assert!(registry.is_busy(concat!(crate::app_slug!(), "-p--agent-1")));
        assert!(!first.evicted());
        let waiter = {
            let registry = registry.clone();
            tokio::spawn(async move { registry.acquire(concat!(crate::app_slug!(), "-p--agent-1")).await })
        };
        // The incumbent is asked to leave; releasing hands the slot over.
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
        assert!(first.evicted(), "incumbent should have been signalled");
        drop(first);
        let second = waiter.await.expect("join").expect("second viewer");
        assert!(!second.evicted());
        assert!(registry.is_busy(concat!(crate::app_slug!(), "-p--agent-1")));
        drop(second);
        assert!(!registry.is_busy(concat!(crate::app_slug!(), "-p--agent-1")));
    }

    /// A pocketed phone keeps its socket and its slot; what it gives up is
    /// "somebody is looking", which is what holds an agent notice back.
    #[tokio::test]
    async fn a_hidden_viewer_holds_the_tab_but_is_not_watching_it() {
        use super::TerminalRegistry;
        let registry = TerminalRegistry::default();
        assert!(!registry.is_watched(concat!(crate::app_slug!(), "-p--agent-3")), "nobody attached");
        let viewer = registry.acquire(concat!(crate::app_slug!(), "-p--agent-3")).await.expect("viewer");
        // A phone that never reports (an older bundle) counts as watching.
        assert!(registry.is_watched(concat!(crate::app_slug!(), "-p--agent-3")));
        assert!(!viewer.hidden());
        // Only a change is an edge: the same state twice stamps nothing twice.
        assert!(!viewer.set_visible(true));
        assert!(viewer.set_visible(false));
        assert!(!viewer.set_visible(false));
        assert!(viewer.hidden());
        assert!(registry.is_busy(concat!(crate::app_slug!(), "-p--agent-3")), "the slot is still held");
        assert!(!registry.is_watched(concat!(crate::app_slug!(), "-p--agent-3")));
        assert!(viewer.set_visible(true));
        assert!(registry.is_watched(concat!(crate::app_slug!(), "-p--agent-3")));
        // The state belongs to the viewer, not the tab: the next one starts
        // out watching whatever the last one reported.
        viewer.set_visible(false);
        drop(viewer);
        assert!(!registry.is_watched(concat!(crate::app_slug!(), "-p--agent-3")));
        let next = registry.acquire(concat!(crate::app_slug!(), "-p--agent-3")).await.expect("next viewer");
        assert!(registry.is_watched(concat!(crate::app_slug!(), "-p--agent-3")));
        drop(next);
    }

    #[test]
    fn only_a_close_the_phone_can_recover_from_asks_it_back() {
        for reason in ["idle_timeout", "session_expired", "catalog_unavailable"] {
            assert!(closing_retries(reason), "{reason}");
        }
        for reason in [
            "access_revoked",
            "replaced",
            "session_busy",
            "invalid_terminal_control",
            "invalid_terminal_size",
            "input_frame_too_large",
            "resize_failed",
        ] {
            assert!(!closing_retries(reason), "{reason}");
        }
    }

    #[tokio::test]
    async fn an_incumbent_that_never_leaves_still_yields_session_busy() {
        use super::TerminalRegistry;
        let registry = TerminalRegistry::default();
        let _held = registry.acquire(concat!(crate::app_slug!(), "-p--agent-2")).await.expect("first");
        match registry.acquire(concat!(crate::app_slug!(), "-p--agent-2")).await {
            Ok(_) => panic!("a held slot must not be handed over"),
            Err(reason) => assert_eq!(reason, "session_busy"),
        }
    }

    #[test]
    fn tmux_attach_uses_a_non_alternate_screen_mobile_client() {
        let command = tmux_attach_command(concat!(crate::app_slug!(), "-project--shell-test"));
        assert_eq!(command.get_env("TERM"), Some(OsStr::new("vt100")));
        assert_eq!(command.get_env("COLORTERM"), Some(OsStr::new("truecolor")));
        let argv = command.get_argv();
        // The program is tmux resolved on Tabtivity's PATH (absolute when installed).
        let program = std::path::Path::new(&argv[0]);
        assert_eq!(
            program.file_stem().and_then(OsStr::to_str),
            Some("tmux"),
            "attach runs tmux: {argv:?}"
        );
        assert_eq!(
            &argv[1..],
            &["-u", "attach-session", "-t", concat!(crate::app_slug!(), "-project--shell-test")].map(OsStr::new)
        );
    }

    fn first_path_dir(path: &OsStr) -> std::path::PathBuf {
        std::env::split_paths(path).next().expect("non-empty PATH")
    }

    #[test]
    fn sidecar_tmux_spawns_use_app_path() {
        let expected = crate::paths::extra_path_dirs()[0].clone();

        let attach = tmux_attach_command(concat!(crate::app_slug!(), "-project--shell-test"));
        let attach_path = attach.get_env("PATH").expect("attach carries PATH");
        assert_eq!(first_path_dir(attach_path), expected);

        for command in [
            tmux_capture_command(concat!(crate::app_slug!(), "-project--shell-test")),
            tmux_window_size_command(concat!(crate::app_slug!(), "-project--shell-test")),
        ] {
            let path = command
                .get_envs()
                .find(|(key, _)| *key == "PATH")
                .and_then(|(_, value)| value)
                .expect("tmux spawn carries PATH");
            assert_eq!(first_path_dir(path), expected);
        }
    }

    #[test]
    fn tmux_capture_replays_the_same_depth_as_mobile_xterm() {
        let command = tmux_capture_command(concat!(crate::app_slug!(), "-project--shell-test"));
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [
                "-u",
                "capture-pane",
                "-p",
                "-e",
                "-J",
                "-S",
                &format!("-{MOBILE_SCROLLBACK_LINES}"),
                "-E",
                "-1",
                "-t",
                concat!(crate::app_slug!(), "-project--shell-test"),
            ]
            .map(OsStr::new)
        );
    }

    #[test]
    fn capture_stops_above_the_visible_screen_the_attach_will_redraw() {
        let command = tmux_capture_command(concat!(crate::app_slug!(), "-project--shell-test"));
        let args: Vec<_> = command
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        // Without `-E -1` the capture ends at the bottom of the visible pane and
        // the attach redraw duplicates that screen on every reconnect.
        let end = args.iter().position(|a| a == "-E").expect("-E");
        assert_eq!(args[end + 1], "-1");
    }

    #[test]
    fn window_size_is_probed_from_the_window_not_the_client() {
        let command = tmux_window_size_command(concat!(crate::app_slug!(), "-project--shell-test"));
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [
                "-u",
                "display-message",
                "-p",
                "-t",
                concat!(crate::app_slug!(), "-project--shell-test"),
                "#{window_width}x#{window_height}",
            ]
            .map(OsStr::new)
        );
    }

    #[test]
    fn window_sizes_outside_the_protocol_range_are_rejected() {
        assert_eq!(parse_window_size("180x48\n"), Some((180, 48)));
        assert_eq!(parse_window_size(" 80x24 "), Some((80, 24)));
        assert_eq!(parse_window_size("0x24"), None);
        assert_eq!(parse_window_size("4000x24"), None);
        assert_eq!(parse_window_size("180"), None);
        assert_eq!(parse_window_size(""), None);
        assert_eq!(parse_window_size("axb"), None);
    }

    #[test]
    fn terminal_events_serialize_as_the_client_expects() {
        assert_eq!(TerminalEvent::Pong.to_frame(), r#"{"type":"pong"}"#);
        assert_eq!(TerminalEvent::Replay.to_frame(), r#"{"type":"replay"}"#);
        assert_eq!(
            TerminalEvent::Window { cols: 180, rows: 48 }.to_frame(),
            r#"{"type":"window","cols":180,"rows":48}"#
        );
        assert_eq!(
            TerminalEvent::Closing { reason: "access_revoked".into(), retry: false }.to_frame(),
            r#"{"type":"closing","reason":"access_revoked","retry":false}"#
        );
        assert_eq!(
            TerminalEvent::Features { visibility: true, send_now: true }.to_frame(),
            r#"{"type":"features","visibility":true,"send_now":true}"#
        );
        assert_eq!(TerminalEvent::SendNow { sent: true }.to_frame(), r#"{"type":"send_now","sent":true}"#);
    }

    #[test]
    fn send_now_reads_the_queue_hint_off_the_input_box_only() {
        let hint = queue_hint("claude").expect("claude has a hint");
        // Claude Code 2.1.310, a message waiting behind the turn.
        assert!(queue_hint_shown("✻ Pondering… (9s · thinking)\n───\n❯ Press up to edit queued messages\n───\n", &hint));
        // 2.1.310 draws the box's space after `❯` as a no-break space.
        assert!(queue_hint_shown("───\n❯\u{a0}Press up to edit queued messages, Enter to send them immediately:\n───", &hint));
        // Taken up by the turn at a tool call: the box is empty again.
        assert!(!queue_hint_shown("❯ Reply only BANANA\n✽ Osmosing… (4s)\n───\n❯ \n───", &hint));
        // The words in the conversation are not the box.
        assert!(!queue_hint_shown("  it said Press up to edit queued messages\n❯ ", &hint));
        // CLIs that take a mid-turn message in at once, or show no queue.
        for family in ["codex", "copilot", "opencode", "gemini", "agent"] {
            assert!(queue_hint(family).is_none(), "{family}");
        }
    }

    /// The local check and press against the real tmux (run with
    /// `--ignored`): the pane echoes the keys it gets, so the Esc shows as `^[`.
    #[cfg(unix)]
    #[test]
    #[ignore = "runs the real tmux"]
    fn local_send_now_presses_esc_into_the_pane_only_while_the_hint_shows() {
        let name = format!("send-now-test-{}", std::process::id());
        let tmux = |args: &[&str]| crate::services::tmux_local::tmux_command().args(args).output().expect("tmux runs");
        let screen = |name: &str| {
            String::from_utf8_lossy(&tmux(&["capture-pane", "-p", "-t", &format!("={name}:")]).stdout).to_string()
        };
        let wait = || std::thread::sleep(std::time::Duration::from_millis(400));
        let hint = queue_hint("claude").unwrap();
        let target = super::AttachTarget::Local { name: name.clone() };

        tmux(&["new-session", "-d", "-s", &name, "-x", "80", "-y", "10", "printf '❯ \\n'; stty raw -echo; cat -v"]);
        wait();
        assert!(!target.send_now(hint));
        wait();
        assert!(!screen(&name).contains("^["));

        tmux(&["kill-session", "-t", &format!("={name}")]);
        tmux(&["new-session", "-d", "-s", &name, "-x", "80", "-y", "10", "printf '❯ Press up to edit queued messages\\n'; stty raw -echo; cat -v"]);
        wait();
        assert!(target.send_now(hint));
        wait();
        let after = screen(&name);
        tmux(&["kill-session", "-t", &format!("={name}")]);
        assert!(after.contains("^["), "{after}");
    }

    #[test]
    fn every_input_frame_is_acked_by_its_ordinal() {
        // The phone counts the binary frames it sent on this socket; the ack
        // names the count written, so frame 3's ack is `{"type":"ack","seq":3}`
        // and nothing else has to ride on a raw keystroke frame.
        assert_eq!(ack_frame(1), r#"{"type":"ack","seq":1}"#);
        assert_eq!(ack_frame(3), r#"{"type":"ack","seq":3}"#);
        assert_eq!(
            serde_json::from_str::<TerminalEvent>(&ack_frame(7)).expect("round trip"),
            TerminalEvent::Ack { seq: 7 }
        );
        // The control vocabulary the phone sends is unchanged by this.
        assert!(matches!(
            serde_json::from_str::<TerminalControl>(r#"{"type":"ping"}"#),
            Ok(TerminalControl::Ping)
        ));
    }

    #[test]
    fn the_replay_goes_out_in_bounded_frames_in_order() {
        assert!(replay_frames(b"").is_empty());
        let small = replay_frames(b"one\r\n");
        assert_eq!(small, vec![b"one\r\n".to_vec()]);
        let history: Vec<u8> = (0..(REPLAY_CHUNK * 2 + 17)).map(|i| (i % 251) as u8).collect();
        let frames = replay_frames(&history);
        assert_eq!(frames.len(), 3);
        assert!(frames.iter().all(|frame| frame.len() <= REPLAY_CHUNK));
        assert_eq!(frames[0].len(), REPLAY_CHUNK);
        assert_eq!(frames[2].len(), 17);
        assert_eq!(frames.concat(), history);
    }

    #[tokio::test]
    async fn a_flooding_pane_waits_for_the_phone_and_loses_nothing() {
        let queue = OutputQueue::new();
        let chunk = vec![b'x'; 16 * 1024];
        let fits = MAX_OUTPUT_QUEUE / chunk.len();
        for _ in 0..fits {
            assert!(queue.push(chunk.clone()));
        }
        // The phone stalls; the pane keeps painting. The reader parks rather
        // than dropping bytes tmux believes the phone already has.
        let (pushed_tx, pushed_rx) = std::sync::mpsc::channel();
        let reader = {
            let queue = queue.clone();
            std::thread::spawn(move || {
                let pushed = queue.push(vec![b'y'; 16 * 1024]);
                pushed_tx.send(pushed).expect("report");
            })
        };
        assert!(
            pushed_rx.recv_timeout(std::time::Duration::from_millis(100)).is_err(),
            "a full queue blocks the reader"
        );
        // The phone takes one chunk: the reader goes on, and every byte is
        // still there, in order.
        assert_eq!(queue.pop().await.as_deref(), Some(&chunk[..]));
        assert_eq!(pushed_rx.recv_timeout(std::time::Duration::from_secs(5)), Ok(true));
        reader.join().expect("reader");
        let mut drained = Vec::new();
        queue.close();
        while let Some(next) = queue.pop().await {
            drained.push(next[0]);
        }
        assert_eq!(drained.len(), fits);
        assert_eq!(drained.last(), Some(&b'y'));
    }

    #[test]
    fn closing_wakes_a_reader_parked_on_a_full_queue() {
        let queue = OutputQueue::new();
        let chunk = vec![b'x'; MAX_OUTPUT_QUEUE];
        assert!(queue.push(chunk.clone()), "one oversized chunk always fits an empty queue");
        let reader = {
            let queue = queue.clone();
            std::thread::spawn(move || queue.push(chunk))
        };
        std::thread::sleep(std::time::Duration::from_millis(50));
        queue.close();
        assert!(!reader.join().expect("reader"), "a closed queue tells the reader to stop");
    }

    #[tokio::test]
    async fn the_output_consumer_ends_only_when_the_reader_has_stopped() {
        let queue = OutputQueue::new();
        let producer = {
            let queue = queue.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                queue.push(b"late".to_vec());
                queue.close();
            })
        };
        assert_eq!(queue.pop().await.as_deref(), Some(&b"late"[..]));
        assert!(queue.pop().await.is_none());
        producer.await.expect("producer");
    }

    #[test]
    fn captured_scrollback_uses_terminal_line_endings() {
        assert_eq!(
            normalize_scrollback(b"one\ntwo\r\nthree".to_vec()),
            b"one\r\ntwo\r\nthree\r\n"
        );
    }

    /// A sink nobody drains — the socket of a phone that dropped off the
    /// network without a FIN.
    struct StalledSink;
    impl futures_util::Sink<Message> for StalledSink {
        type Error = ();
        fn poll_ready(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), ()>> {
            Poll::Pending
        }
        fn start_send(self: Pin<&mut Self>, _: Message) -> Result<(), ()> {
            Ok(())
        }
        fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), ()>> {
            Poll::Pending
        }
        fn poll_close(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), ()>> {
            Poll::Pending
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_frame_the_phone_never_takes_is_given_up_on_rather_than_waited_for() {
        let started = tokio::time::Instant::now();
        let mut sink = StalledSink;
        assert!(!deliver(&mut sink, Message::Text("x".to_string().into())).await);
        // The wait is the write deadline, not the kernel's retransmission timer.
        assert!(started.elapsed() >= WRITE_TIMEOUT);
        assert!(started.elapsed() < WRITE_TIMEOUT * 2);
    }

    /// A backgrounded PWA's ping arrives about once a minute; the reaper must
    /// sit well clear of that, or every minute in the background costs a full
    /// history replay.
    #[test]
    fn the_idle_reaper_outlasts_a_throttled_background_ping() {
        const THROTTLED_PING: std::time::Duration = std::time::Duration::from_secs(60);
        assert!(IDLE_TIMEOUT >= THROTTLED_PING * 2);
    }

    #[tokio::test]
    async fn a_frame_the_phone_takes_is_reported_delivered() {
        let mut sink = futures_util::sink::drain();
        assert!(deliver(&mut sink, Message::Text("x".to_string().into())).await);
    }

    /// Every frame through one filter, the way the bridge feeds it: the bytes
    /// that go on to the pane.
    fn through(frames: &[&[u8]]) -> Vec<u8> {
        let mut filter = MouseReportFilter::default();
        frames.iter().flat_map(|frame| filter.feed(frame)).collect()
    }

    #[test]
    fn mouse_reports_of_every_form_are_dropped_and_the_rest_goes_through() {
        // X10, SGR press and release, urxvt; a right click and an Alt+right
        // click (the buttons that open tmux's pane menu) among them.
        for report in [
            &b"\x1b[M\"!!"[..],
            b"\x1b[M2!!",
            b"\x1b[<2;10;5M",
            b"\x1b[<34;10;5M",
            b"\x1b[<2;10;5m",
            b"\x1b[<0;1;1M",
            b"\x1b[34;10;5M",
            "\u{1b}[M\"\u{12d}!".as_bytes(),
        ] {
            assert_eq!(through(&[report]), b"", "{report:?}");
            let mut framed = b"ls".to_vec();
            framed.extend_from_slice(report);
            framed.extend_from_slice(b"\r");
            assert_eq!(through(&[&framed]), b"ls\r", "{report:?}");
        }
    }

    #[test]
    fn keys_and_text_are_not_touched() {
        for input in [
            &b"hello world\r"[..],
            b"\x1b[A\x1b[B\x1bOA\x1b[1;5C\x1b[3~\x1b[200~paste\x1b[201~",
            b"\x1bx",
            b"\x03\x1b\x1b[Z",
            b"[<2;10;5M",
            "snow \u{2603} man".as_bytes(),
        ] {
            assert_eq!(through(&[input]), input, "{input:?}");
        }
    }

    #[test]
    fn a_report_split_over_frames_is_dropped_wherever_it_splits() {
        let report = b"\x1b[<2;10;5M";
        for cut in 1..report.len() {
            let (a, b) = report.split_at(cut);
            assert_eq!(through(&[a, b]), b"", "cut at {cut}");
        }
        let x10 = b"\x1b[M\"!!";
        for cut in 1..x10.len() {
            let (a, b) = x10.split_at(cut);
            assert_eq!(through(&[a, b]), b"", "x10 cut at {cut}");
        }
        // One byte a frame.
        let frames: Vec<&[u8]> = report.chunks(1).collect();
        assert_eq!(through(&frames), b"");
        // A held prefix is never forwarded in part: nothing came out yet.
        let mut filter = MouseReportFilter::default();
        assert!(filter.feed(b"\x1b[<2;1").is_empty());
        assert!(filter.pending());
    }

    #[test]
    fn a_prefix_that_turns_out_not_to_be_a_report_goes_on_whole() {
        // Held, then released by what follows.
        assert_eq!(through(&[b"\x1b", b"[A"]), b"\x1b[A");
        assert_eq!(through(&[b"\x1b[1;", b"5A"]), b"\x1b[1;5A");
        assert_eq!(through(&[b"\x1b[", b"3~"]), b"\x1b[3~");
        // A report-shaped start that breaks off is dropped, the new escape kept.
        assert_eq!(through(&[b"\x1b[<2;1\x1b[A"]), b"\x1b[A");
        assert_eq!(through(&[b"\x1b[<2;1x"]), b"x");
        // Longer than tmux reads: dropped, the digits after it are plain text.
        let long = [b"\x1b[<".as_slice(), &[b'1'; 80], b"M"].concat();
        assert!(!through(&[&long]).contains(&0x1b));
    }

    #[test]
    fn a_lone_escape_is_the_key_after_the_hold_and_a_late_report_still_drops() {
        let mut filter = MouseReportFilter::default();
        assert!(filter.feed(b"\x1b").is_empty());
        assert!(filter.pending());
        assert_eq!(filter.flush(), b"\x1b");
        // The Esc is out: nothing more to hold on a timer, and it is not sent twice.
        assert!(!filter.pending());
        assert!(filter.flush().is_empty());
        // tmux may still be waiting on its `escape-time` for the rest of a
        // sequence: a report finishing now is dropped whole.
        assert!(filter.feed(b"[<2;10;5M").is_empty());
        assert!(!filter.pending());
        // …and what is not one goes on without a second Esc.
        let mut filter = MouseReportFilter::default();
        filter.feed(b"\x1b");
        filter.flush();
        assert_eq!(filter.feed(b"[A"), b"[A");
        assert_eq!(filter.feed(b"ab"), b"ab");
    }

    #[test]
    fn a_partial_report_is_dropped_when_the_hold_runs_out() {
        let mut filter = MouseReportFilter::default();
        assert!(filter.feed(b"\x1b[<2;10").is_empty());
        assert!(filter.pending());
        assert!(filter.flush().is_empty());
        assert!(!filter.pending());
        // Nothing of it is left to join what comes next.
        assert_eq!(filter.feed(b";5Mx"), b";5Mx");
    }
}

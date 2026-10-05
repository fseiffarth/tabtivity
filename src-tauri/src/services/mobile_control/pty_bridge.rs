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
        let mut busy = self.busy.lock().unwrap_or_else(PoisonError::into_inner);
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
        self.busy.lock().unwrap_or_else(PoisonError::into_inner).contains_key(name)
    }

    /// A phone has this tab open *and in front of someone*. `is_busy` alone
    /// stays true for a pocketed phone — the page is hidden, not gone, and its
    /// socket lives on for as long as throttled pings arrive (or `IDLE_TIMEOUT`
    /// after they stop) — which is exactly when its reader needs the "finished"
    /// or "needs your answer" notice that an attached tab does not get.
    pub fn is_watched(&self, name: &str) -> bool {
        self.busy
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
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
                let mut busy = self.busy.lock().unwrap_or_else(PoisonError::into_inner);
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
    let mut command = crate::paths::command_no_window("tmux");
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
    let mut command = crate::paths::command_no_window("tmux");
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

/// `window-size largest` sizes a window to the widest attached client, and tmux
/// then *pans* any smaller client across it — so a phone fitted to its own
/// viewport received a ~44-column moving slice of a ~180-column pane with every
/// line silently truncated. The phone adopts the window geometry instead: its
/// xterm is an offscreen emulator whose column count never had to match the
/// physical screen, and the reading view re-wraps for display.
fn window_size(tmux_name: &str) -> Option<(u16, u16)> {
    let output = tmux_window_size_command(tmux_name).output().ok()?;
    if !output.status.success() {
        return None;
    }
    parse_window_size(&String::from_utf8_lossy(&output.stdout))
}

/// How often the window geometry is re-checked. The desktop can widen the window
/// at any time, which would silently reintroduce the pan.
const WINDOW_POLL: std::time::Duration = std::time::Duration::from_secs(5);

fn captured_scrollback(tmux_name: &str) -> Vec<u8> {
    let Ok(output) = tmux_capture_command(tmux_name).output() else {
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
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
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
        self.state.lock().unwrap_or_else(PoisonError::into_inner).closed = true;
        self.ready.notify_one();
        self.space.notify_all();
    }

    /// The next chunk; `None` once the reader has stopped and nothing is left.
    async fn pop(&self) -> Option<Vec<u8>> {
        loop {
            {
                let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
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

/// Whether a close for `reason` tells the phone to come back. `replaced` means
/// another viewer took over; that client must not fight its way back in a
/// reconnect loop. `session_expired` retries through the phone's silent
/// re-login. `catalog_unavailable` is the bridge not being able to *ask*
/// whether the tab is still granted — nothing was revoked, so the phone
/// reconnects and the upgrade route decides; `access_revoked` is the catalog
/// answering no (the project's phone access switched off, the tab or its
/// session gone), and stays final.
fn closing_retries(reason: &str) -> bool {
    matches!(reason, "idle_timeout" | "session_expired" | "catalog_unavailable")
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
    tmux_name: String,
    registry: TerminalRegistry,
    auth: Arc<Mutex<AuthStore>>,
    token: String,
    state_dir: PathBuf,
    tab_id: String,
    catalog: Arc<Mutex<CatalogCache>>,
    // Called on the leading edge of each burst of typing from this viewer (see
    // `INPUT_REPORT_INTERVAL`). A callback rather than a desktop call of its
    // own, so this module keeps knowing nothing about the desktop socket.
    on_input: impl Fn(),
    // Called at each moment the screen was last, or is again, in front of
    // somebody: when the phone reports its page hidden or visible, and at
    // detach unless the page was hidden by then (see `host::terminal`).
    on_seen: impl Fn(),
) -> Result<(), String> {
    let guard = registry.acquire(&tmux_name).await?;
    // Do this before the live attach starts redrawing. The browser receives it
    // before every PTY byte below, and tmux's clear/redraw then leaves these
    // lines in xterm's normal scrollback buffer above the live screen. The
    // geometry probe rides along in the same blocking hop.
    let probe_name = tmux_name.clone();
    let (history, initial_window) =
        tokio::task::spawn_blocking(move || (captured_scrollback(&probe_name), window_size(&probe_name)))
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
    let command = tmux_attach_command(&tmux_name);
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
    let window_name = tmux_name.clone();
    let window_task = tokio::spawn(async move {
        let mut last = initial_window;
        let mut tick = tokio::time::interval(WINDOW_POLL);
        tick.tick().await;
        loop {
            tick.tick().await;
            let probe = window_name.clone();
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
    let session = PtySession {
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
    opening.push(TerminalEvent::Features { visibility: true }.to_frame());
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
    // The phone spoke: its session slides (`auth::SESSION_IDLE`). Every frame
    // it sends, not the tick — a tick is the sidecar checking, not the phone.
    let touch = |auth: &Arc<Mutex<AuthStore>>| {
        auth.lock().unwrap_or_else(PoisonError::into_inner).touch(&token);
    };
    let result: Result<(), String> = loop {
        tokio::select! {
            _ = authorization_tick.tick() => {
                if guard.evicted() { break Err("replaced".into()); }
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
                        let mut auth = auth.lock().unwrap_or_else(PoisonError::into_inner);
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
                            catalog.lock().unwrap_or_else(PoisonError::into_inner).load(&state_dir, &key)
                        })
                        .await
                    };
                    if let Err(reason) = recheck(loaded.ok().and_then(Result::ok), &device, &tab_id, &tmux_name) {
                        break Err(reason.into());
                    }
                }
                tick = tick.wrapping_add(1);
            }
            Some((cols, rows)) = window_rx.recv() => {
                if !deliver(&mut ws_tx, Message::Text(TerminalEvent::Window { cols, rows }.to_frame().into())).await { break Ok(()); }
            }
            chunk = output.pop() => match chunk {
                Some(bytes) => if !deliver(&mut ws_tx, Message::Binary(bytes.into())).await { break Ok(()); },
                // The pane's output ended: tmux detached the client, or the
                // session is gone.
                None => break Ok(()),
            },
            incoming = ws_rx.next() => match incoming {
                Some(Ok(Message::Binary(bytes))) => {
                    last_client_message = std::time::Instant::now();
                    touch(&auth);
                    if bytes.len() > MAX_INPUT_FRAME { break Err("input_frame_too_large".into()); }
                    if writer.write_all(&bytes).is_err() || writer.flush().is_err() { break Ok(()); }
                    // After the write, so a frame that never reached the PTY is
                    // never reported as having commanded it — and never acked.
                    input_frames += 1;
                    if !deliver(&mut ws_tx, Message::Text(ack_frame(input_frames).into())).await { break Ok(()); }
                    if input_report_due(last_input_report, last_client_message) {
                        last_input_report = Some(last_client_message);
                        on_input();
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
/// past it) is the catalog saying no.
fn recheck(loaded: Option<Catalog>, device: &str, tab_id: &str, tmux_name: &str) -> Result<(), &'static str> {
    match loaded.map(|catalog| catalog.for_device(device).grants(tab_id, tmux_name)) {
        Some(true) => Ok(()),
        Some(false) => Err("access_revoked"),
        None => Err("catalog_unavailable"),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        normalize_scrollback, parse_window_size, tmux_attach_command, tmux_capture_command,
        tmux_window_size_command, MOBILE_SCROLLBACK_LINES,
    };
    use super::{
        ack_frame, closing_retries, deliver, input_report_due, replay_frames, OutputQueue, IDLE_TIMEOUT,
        INPUT_REPORT_INTERVAL, REPLAY_CHUNK, WRITE_TIMEOUT,
    };
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
            TerminalEvent::Features { visibility: true }.to_frame(),
            r#"{"type":"features","visibility":true}"#
        );
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
}

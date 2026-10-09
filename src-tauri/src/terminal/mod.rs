//! PTY lifecycle management for Tabtivity terminals.
//!
//! Design constraints from TauriRust.md Phase 3:
//! - portable-pty for cross-platform PTY creation.
//! - Bounded per-PTY output channels (backpressure via mpsc).
//! - Batched/throttled Tauri events (mid-burst, one emit per 16 ms window or
//!   per `BATCH_MAX_BYTES` of output, whichever comes first; the first chunk
//!   after quiet flushes immediately, and an idle PTY parks with no timer at
//!   all — see `batch_output`).
//! - Stateful UTF-8 output decoding; binary-safe read loop.
//! - Crash-loop protection: tracks last-exit timestamps.
//! - Explicit terminal-ready event when the shell starts.
//! - Linux XDG sandbox env in a cfg(target_os="linux") block.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use portable_pty::{Child, CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::services::window_service::MAIN_WINDOW_LABEL;

// ── Constants ─────────────────────────────────────────────────────────────

const BATCH_INTERVAL: Duration = Duration::from_millis(16);
/// Size cap on one coalesced emit — the backpressure bound on a single
/// `terminal-output` payload. **Must stay well above the reader thread's read
/// buffer** (the `[0u8; 4096]` in `spawn_pty`): `batch_output` flushes as soon as
/// `batch.len() >= BATCH_MAX_BYTES`, so when the two were both 4096 every full
/// read of a sustained burst (a build log) tripped the size rule on its own and
/// the 16 ms window coalesced nothing — one IPC event per 4 KiB. At 32 KiB a
/// burst takes ~8 reads per emit. The two literals are independent and nothing
/// else ties them: "making them consistent" or sharing one constant silently
/// restores that bug with every `batch_tests` case still green.
const BATCH_MAX_BYTES: usize = 32768;
#[allow(dead_code)]
const MIN_RESTART_INTERVAL: Duration = Duration::from_secs(2);
const CRASH_LOOP_THRESHOLD: usize = 5;
pub const SCROLLBACK_LIMIT: usize = 5000;

/// Internal channel capacity — limits buffered output chunks.
const CHANNEL_CAP: usize = 64;
/// Per-PTY input queue capacity. The frontend keeps one write in flight and
/// coalesces ordinary keystrokes, so this is primarily a bounded safety net for
/// other callers rather than a source of typing latency.
const INPUT_CHANNEL_CAP: usize = 64;

// ── Visible-only streaming ────────────────────────────────────────────────
//
// A hidden pane's PTY used to stream every chunk over IPC anyway: the frontend
// buffered it instead of feeding xterm (its half of the fix), but each emit
// still woke the GTK main thread and a JS listener — with dozens of streaming
// agent tabs the renderer was poked constantly and never reached idle, which
// is what forfeits the scheduler's interactive fast path
// (docs/typing_latency_plan.md). So the gate moved backend-side: a PTY whose
// pane is hidden stops emitting `terminal-output` entirely. Its output
// accumulates in an in-Rust `pending` buffer (front-trimmed at
// `ROUTE_PENDING_CAP`; agent TUIs repaint whole screens, so the replay
// converges on the current frame), and the pills stay honest through
// `terminal-activity` digests: the accumulated tail, emitted leading-edge and
// then at most once per `ACTIVITY_INTERVAL`, with a trailing flush so the
// decision prompt that arrives right before quiet is still reported.
//
// Showing the pane again (`pty_set_visible`) drains `pending` as ONE
// `terminal-replay` event — a separate event name because replayed output is
// STALE output written late: the frontend must route it through its
// stripTerminalQueries guard, never a bare `term.write` (a terminal query in
// it would be answered on parse and typed into the shell). The drain is
// emitted while the routes lock is held; every live chunk emit also takes
// that lock first, so the replay provably precedes any output produced after
// the flip.
//
// `watchers` is the override for consumers that scan a possibly-hidden PTY's
// raw stream for markers (`useRemoteSession`/`useRemoteReconnect`'s login
// terminals): while a watch is held the PTY streams `terminal-output` as if
// visible. A watch's rising edge drains `pending` the same way, so the hidden
// pane's own buffer stays in byte order across the watch.

/// How often a hidden PTY's buffered output is condensed into a
/// `terminal-activity` digest. Must stay well under the activity store's
/// BUSY_WINDOW_MS (800 ms): the "working" classifier treats a gap that long
/// as the end of a burst, so a slower cadence would make every hidden
/// streaming tab read as idle between digests.
const ACTIVITY_INTERVAL: Duration = Duration::from_millis(500);

/// How much hidden-spell output is retained for the show-again replay.
/// Mirrors the frontend's PENDING_OUTPUT_CAP.
const ROUTE_PENDING_CAP: usize = 1_000_000;

/// How much of a PTY's output is retained for a LATER viewer to catch up on
/// (Group B #235).
///
/// `pending` above answers "what did this pane miss while it was hidden"; this
/// answers "what has this terminal shown at all", which is a different question
/// and the one a SECOND viewer asks. A tab popped out into its own window opens
/// a fresh xterm on a PTY that has been running for an hour: it used to render
/// empty until the program next drew (a TUI recovers via the fit's SIGWINCH, a
/// plain shell's history existed only in the main window's hidden xterm), and
/// every seed-driven remount blanked it again. So the router keeps a bounded
/// tail of everything it routed — visible or not — and a new attach replays it
/// before its first live byte.
///
/// Deliberately smaller than the hidden-spell buffer: this one is retained for
/// EVERY live PTY rather than only for hidden ones, and a screenful of context
/// is what the reader actually wants. A TUI repaints its whole frame, so the
/// replay converges on the current screen either way.
const ROUTE_SCROLLBACK_CAP: usize = 256_000;

/// How much tail one `terminal-activity` digest carries — enough for the
/// activity store's 8 KB decision-prompt scan.
const ACTIVITY_TAIL_CAP: usize = 8192;

/// One TerminalView instance's registration with the router.
#[derive(Clone, Debug)]
struct ViewerReg {
    visible: bool,
    /// The view's own monotonic update counter, so a late report cannot
    /// overwrite a newer one.
    seq: u64,
    /// The Tauri window this view lives in. Recorded so a window that dies
    /// without unmounting its React tree can have its registrations dropped
    /// (Group B #238): every popout teardown uses `destroy()`, which runs no
    /// cleanup, so the popout's `pty_remove_view` never fired and the route kept
    /// a `visible: true` viewer under a random uuid forever — every tab that had
    /// ever been popped out streamed over IPC for the rest of the session,
    /// undoing the visible-only streaming work.
    window: String,
}

/// Per-PTY routing state. Fresh output buffers until a concrete TerminalView
/// reports itself visible; this avoids a spawn race without inventing a global
/// last-writer-wins view.
#[derive(Default)]
struct OutputRoute {
    /// Stable TerminalView instances currently registered, by viewer id. A PTY
    /// can be rendered in both the main and a detached webview, so a single
    /// last-writer-wins boolean is not sufficient.
    visible_viewers: HashMap<String, ViewerReg>,
    watchers: u32,
    /// Output accumulated while unsubscribed, replayed on the next rising edge.
    pending: String,
    /// A bounded tail of everything routed for this PTY (see
    /// `ROUTE_SCROLLBACK_CAP`), so a viewer attaching to an already-running
    /// terminal can catch up instead of opening blank.
    retained: String,
    /// Absolute UTF-8 byte offset of `retained[0]` in this spawn's output.
    retained_start: u64,
    /// Absolute UTF-8 byte offset of `pending[0]`.
    pending_start: u64,
    /// Absolute UTF-8 byte offset immediately after the latest routed chunk.
    output_offset: u64,
    /// Output since the last activity digest (tail-capped).
    digest: String,
    /// UTF-8 decoder state shared by every output chunk for this spawn.
    decoder: Utf8StreamDecoder,
    /// When the last digest was emitted; `None` = the next one is leading-edge.
    last_activity: Option<Instant>,
    /// A trailing-flush task is sleeping toward `last_activity + interval`.
    digest_armed: bool,
    /// Spawn generation, so a respawn under the same id survives the previous
    /// spawn's task-end cleanup.
    seq: u64,
}

impl OutputRoute {
    fn subscribed(&self) -> bool {
        self.visible_viewers.values().any(|v| v.visible) || self.watchers > 0
    }

    /// Every window other than the main one with a view of this PTY registered,
    /// shown or hidden (a hidden view still buffers what a sibling view streams).
    /// See `emit_output`.
    fn viewer_windows(&self) -> Vec<String> {
        let mut windows: Vec<String> = Vec::new();
        for v in self.visible_viewers.values() {
            if v.window != MAIN_WINDOW_LABEL && !windows.contains(&v.window) {
                windows.push(v.window.clone());
            }
        }
        windows
    }

    /// Append to the always-on catch-up tail. Called for every routed chunk,
    /// visible or not — that is the point: the question it answers is "what has
    /// this terminal shown", which does not depend on who was watching.
    ///
    /// Takes the decoded chunk by value and moves it into the returned slice:
    /// this runs for every chunk of every PTY, and borrowing here forced a
    /// second copy (`to_string`) of a String the caller no longer needed.
    /// Callers that still want the text read it back from `slice.text`.
    fn retain(&mut self, text: String) -> OutputSlice {
        let start_offset = self.output_offset;
        self.output_offset += text.len() as u64;
        self.retained.push_str(&text);
        self.retained_start += trim_with_hysteresis(&mut self.retained, ROUTE_SCROLLBACK_CAP) as u64;
        OutputSlice {
            text,
            start_offset,
            end_offset: self.output_offset,
            windows: Vec::new(),
        }
    }

    fn push_pending(&mut self, slice: &OutputSlice) {
        if self.pending.is_empty() {
            self.pending_start = slice.start_offset;
        }
        self.pending.push_str(&slice.text);
        self.pending_start += trim_with_hysteresis(&mut self.pending, ROUTE_PENDING_CAP) as u64;
    }

    /// Drain the hidden-spell buffer for a replay emit. Also drops the digest:
    /// its bytes are a subset of `pending` and have just been delivered.
    fn take_pending(&mut self) -> Option<OutputSlice> {
        self.digest.clear();
        if self.pending.is_empty() {
            return None;
        }
        let text = std::mem::take(&mut self.pending);
        let start_offset = self.pending_start;
        self.pending_start = self.output_offset;
        Some(OutputSlice {
            text,
            start_offset,
            end_offset: self.output_offset,
            windows: self.viewer_windows(),
        })
    }
}

#[derive(Default)]
struct Utf8StreamDecoder {
    pending: Vec<u8>,
}

impl Utf8StreamDecoder {
    /// Decode all complete UTF-8 in `bytes`, retaining only an incomplete suffix
    /// for the next PTY read. Invalid sequences are replaced exactly once.
    fn push(&mut self, bytes: &[u8]) -> String {
        // The common case — no split codepoint carried over, a chunk that is
        // all valid UTF-8 — is one validation and one copy, rather than a copy
        // into `pending`, a validation and a second copy out of it. Every flush
        // of every PTY comes through here.
        if self.pending.is_empty() {
            if let Ok(valid) = std::str::from_utf8(bytes) {
                return valid.to_owned();
            }
        }
        self.pending.extend_from_slice(bytes);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(valid) => {
                    out.push_str(valid);
                    self.pending.clear();
                    break;
                }
                Err(err) => {
                    let valid_up_to = err.valid_up_to();
                    if valid_up_to > 0 {
                        out.push_str(
                            std::str::from_utf8(&self.pending[..valid_up_to])
                                .expect("Utf8Error::valid_up_to must be valid UTF-8"),
                        );
                    }
                    match err.error_len() {
                        Some(invalid_len) => {
                            out.push('\u{fffd}');
                            self.pending.drain(..valid_up_to + invalid_len);
                        }
                        None => {
                            self.pending.drain(..valid_up_to);
                            break;
                        }
                    }
                }
            }
        }
        out
    }

    fn finish(&mut self) -> String {
        if self.pending.is_empty() {
            String::new()
        } else {
            let text = String::from_utf8_lossy(&self.pending).into_owned();
            self.pending.clear();
            text
        }
    }
}

fn routes() -> &'static Mutex<HashMap<String, OutputRoute>> {
    static ROUTES: OnceLock<Mutex<HashMap<String, OutputRoute>>> = OnceLock::new();
    ROUTES.get_or_init(|| Mutex::new(HashMap::new()))
}


/// Trim with hysteresis (the frontend buffer's rule): cutting exactly to the
/// cap on every chunk past it re-copies the whole buffer per chunk; letting it
/// grow to 2× and cutting back costs one copy per cap's worth of new output.
/// The buffer already contains decoded text, so advance the cut to a character
/// boundary rather than creating replacement characters during replay.
fn trim_with_hysteresis(buf: &mut String, cap: usize) -> usize {
    if buf.len() > cap * 2 {
        let mut cut = buf.len() - cap;
        while cut < buf.len() && !buf.is_char_boundary(cut) {
            cut += 1;
        }
        buf.drain(..cut);
        return cut;
    }
    0
}

#[derive(Debug)]
struct OutputSlice {
    text: String,
    start_offset: u64,
    end_offset: u64,
    /// The secondary windows (popouts) holding a view of this PTY, each sent
    /// its own copy of the chunk (`emit_output`). Filled only when the slice is
    /// emitted; empty for a PTY shown only in the main window.
    windows: Vec<String>,
}

/// What the batcher should do with one flushed chunk.
#[derive(Debug)]
enum Routed {
    /// Subscribed: emit as ordinary `terminal-output`.
    Data(OutputSlice),
    /// Hidden, digest due: emit as `terminal-activity`.
    Activity(String),
    /// Hidden, inside the digest window: spawn a trailing flush for this
    /// deadline (nothing was armed yet).
    ArmDigest(Instant),
    /// Hidden, a trailing flush is already armed: nothing to do.
    Quiet,
}

fn route_chunk_at(id: &str, bytes: &[u8], now: Instant, seq: u64) -> Routed {
    let mut map = routes().lock().unwrap();
    // Generation guard, the same one the task-end cleanup uses (`route_close`).
    // A superseded spawn keeps draining its PTY after the replacement opened the
    // route: `insert()` flips the dead flag and reaps the child, but the reader
    // thread is parked inside `read()` and still delivers whatever the dying
    // program writes on its way out — for a TUI, a whole teardown frame. Those
    // bytes belong to the tab that is gone, so routing them here would decode
    // them through the new spawn's decoder, advance its byte offsets, and emit
    // them under the shared id: the previous tab's final screen interleaved into
    // the replacement's terminal. Drop them instead.
    let Some(route) = map.get_mut(id) else {
        return Routed::Quiet;
    };
    if route.seq != seq {
        return Routed::Quiet;
    }
    let text = route.decoder.push(bytes);
    if text.is_empty() {
        return Routed::Quiet;
    }
    let mut slice = route.retain(text);
    if route.subscribed() {
        slice.windows = route.viewer_windows();
        return Routed::Data(slice);
    }
    route.push_pending(&slice);
    route.digest.push_str(&slice.text);
    trim_with_hysteresis(&mut route.digest, ACTIVITY_TAIL_CAP);
    let due = route
        .last_activity
        .is_none_or(|t| now.duration_since(t) >= ACTIVITY_INTERVAL);
    if due {
        route.last_activity = Some(now);
        let text = std::mem::take(&mut route.digest);
        Routed::Activity(text)
    } else if !route.digest_armed {
        route.digest_armed = true;
        // `!due` implies `last_activity` is Some.
        Routed::ArmDigest(route.last_activity.unwrap() + ACTIVITY_INTERVAL)
    } else {
        Routed::Quiet
    }
}

fn route_chunk(id: &str, bytes: &[u8], seq: u64) -> Routed {
    route_chunk_at(id, bytes, Instant::now(), seq)
}

/// Flush an incomplete UTF-8 suffix when the PTY reaches EOF. Complete streams
/// produce no extra event; a genuinely truncated codepoint produces one
/// replacement character and follows the current visible/hidden route.
fn route_finish(id: &str, seq: u64) -> Routed {
    let mut map = routes().lock().unwrap();
    let Some(route) = map.get_mut(id) else {
        return Routed::Quiet;
    };
    // Generation guard — see `route_chunk_at`. The trailing partial codepoint of
    // a superseded spawn is that spawn's, not the replacement's.
    if route.seq != seq {
        return Routed::Quiet;
    }
    let text = route.decoder.finish();
    if text.is_empty() {
        return Routed::Quiet;
    }
    let mut slice = route.retain(text);
    if route.subscribed() {
        slice.windows = route.viewer_windows();
        return Routed::Data(slice);
    }
    route.push_pending(&slice);
    route.digest.push_str(&slice.text);
    trim_with_hysteresis(&mut route.digest, ACTIVITY_TAIL_CAP);
    route.last_activity = Some(Instant::now());
    Routed::Activity(std::mem::take(&mut route.digest))
}

/// The trailing digest flush: drain whatever the window's remaining chunks
/// left, so the last output before a quiet spell (the decision prompt, above
/// all) always reaches the activity store.
fn route_digest_take_at(id: &str, now: Instant) -> Option<String> {
    let mut map = routes().lock().unwrap();
    let route = map.get_mut(id)?;
    route.digest_armed = false;
    if route.subscribed() || route.digest.is_empty() {
        return None;
    }
    route.last_activity = Some(now);
    let text = std::mem::take(&mut route.digest);
    Some(text)
}

fn route_digest_take(id: &str) -> Option<String> {
    route_digest_take_at(id, Instant::now())
}

/// A route under a fresh generation, for the tests.
#[cfg(test)]
fn route_open(id: &str) -> u64 {
    let seq = crate::services::agent_fence::next_spawn_seq();
    route_open_at(id, seq);
    seq
}

/// Register a (re)spawn: keep the pane's visibility and any watchers, drop
/// stale buffers, and record the generation the task-end cleanup is guarded
/// by — the spawn's own sequence number (`PreparedLaunch::spawn_seq`), so the
/// task end names the spawn it belonged to.
fn route_open_at(id: &str, seq: u64) {
    let mut map = routes().lock().unwrap();
    let route = map.entry(id.to_string()).or_default();
    route.pending.clear();
    route.digest.clear();
    // A respawn is a new program: its predecessor's screen is not this one's
    // catch-up. (Same reason the pending buffer is cleared.)
    route.retained.clear();
    route.retained_start = 0;
    route.pending_start = 0;
    route.output_offset = 0;
    route.decoder = Utf8StreamDecoder::default();
    route.last_activity = None;
    route.seq = seq;
}

/// The retained catch-up tail for `id` (Group B #235), or an empty string when
/// nothing is known about that PTY. Read-only: a replay does NOT consume it, so
/// a second window attaching later gets the same history.
pub fn route_scrollback(id: &str) -> TerminalScrollback {
    let map = routes().lock().unwrap();
    match map.get(id) {
        Some(route) => TerminalScrollback {
            data: route.retained.clone(),
            start_offset: route.retained_start,
            end_offset: route.output_offset,
        },
        None => TerminalScrollback::default(),
    }
}

/// Task-end cleanup, guarded by generation so an old spawn's exit can never
/// remove the route a respawn under the same id just opened. Returns whether
/// this was the current spawn, which makes the lifecycle notification obey the
/// same guard as the route cleanup.
fn route_close(id: &str, seq: u64) -> bool {
    let mut map = routes().lock().unwrap();
    if !map.get(id).is_some_and(|r| r.seq == seq) {
        return false;
    }
    let remove = map
        .get(id)
        .is_some_and(|r| r.visible_viewers.is_empty() && r.watchers == 0);
    if remove {
        map.remove(id);
    } else if let Some(route) = map.get_mut(id) {
        route.seq = 0;
        route.decoder = Utf8StreamDecoder::default();
    }
    true
}

/// Emit a rising edge's replay while STILL holding the routes lock: every live
/// chunk emit also takes this lock first (`route_chunk`), so the replay is
/// guaranteed to precede any output produced after the flip.
fn emit_replay(app: &AppHandle, id: &str, route: &mut OutputRoute) {
    if let Some(slice) = route.take_pending() {
        emit_output(app, "terminal-replay", id, slice);
    }
}

/// Emit a chunk of a PTY's output (`terminal-output`) or a replay
/// (`terminal-replay`). Tauri evaluates every emit in every webview that
/// listens for that event name, whatever the listener's target, so one shared
/// name made each popout parse every chunk of every PTY the main window
/// streams. The main window keeps the plain name: it receives every chunk, as
/// its activity classifier needs. A popout listens on `<event>:<its label>`
/// (`terminalBus.ts`) and gets only the PTYs it has a view of.
fn emit_output(app: &AppHandle, event: &str, id: &str, slice: OutputSlice) {
    let payload = TerminalOutput {
        id: id.to_string(),
        data: slice.text,
        start_offset: Some(slice.start_offset),
        end_offset: Some(slice.end_offset),
    };
    for window in &slice.windows {
        let _ = app.emit(&format!("{event}:{window}"), &payload);
    }
    let _ = app.emit(event, payload);
}

/// One TerminalView instance's visibility report (`pty_set_visible`). `window`
/// is the label of the Tauri window the view lives in, taken from the CALLING
/// window rather than from the payload, so a view can only ever speak for
/// itself — and so `route_drop_window_views` can clean up after a window that
/// died without unmounting.
pub fn route_set_visible(
    app: &AppHandle,
    id: &str,
    viewer_id: &str,
    visible: bool,
    update_seq: u64,
    window: &str,
) {
    let mut map = routes().lock().unwrap();
    let route = map.entry(id.to_string()).or_default();
    let was = route.subscribed();
    let current_seq = route
        .visible_viewers
        .get(viewer_id)
        .map(|v| v.seq)
        .unwrap_or(0);
    if update_seq < current_seq {
        return;
    }
    route.visible_viewers.insert(
        viewer_id.to_string(),
        ViewerReg {
            visible,
            seq: update_seq,
            window: window.to_string(),
        },
    );
    if !was && route.subscribed() {
        emit_replay(app, id, route);
    }
}

/// Remove a TerminalView instance without changing any sibling view's state.
pub fn route_remove_view(id: &str, viewer_id: &str, update_seq: u64) {
    let mut map = routes().lock().unwrap();
    let Some(route) = map.get_mut(id) else { return };
    if route
        .visible_viewers
        .get(viewer_id)
        .is_some_and(|v| v.seq > update_seq)
    {
        return;
    }
    route.visible_viewers.remove(viewer_id);
    if route.seq == 0 && route.visible_viewers.is_empty() && route.watchers == 0 {
        map.remove(id);
    }
}

/// Drop every view registered from `window`, across every PTY (Group B #238).
///
/// The counterpart to `route_remove_view` for a window that never gets to run
/// its cleanup: every popout teardown in the app uses `destroy()`, deliberately
/// (it bypasses the popout's own close handler), so its React tree is torn down
/// without effects running and its `pty_remove_view` never fires. The route then
/// holds a `visible: true` viewer for a window that no longer exists, and the
/// PTY streams over IPC forever — for every tab that was ever popped out. Called
/// from the `WindowEvent::Destroyed` hook. Returns how many were dropped, so a
/// caller can log/test it.
pub fn route_drop_window_views(window: &str) -> usize {
    let mut map = routes().lock().unwrap();
    let mut dropped = 0usize;
    let mut empty: Vec<String> = Vec::new();
    for (id, route) in map.iter_mut() {
        let before = route.visible_viewers.len();
        route.visible_viewers.retain(|_, v| v.window != window);
        dropped += before - route.visible_viewers.len();
        // Same collection rule `route_remove_view` applies: a route whose spawn
        // has already ended and that nothing watches any more is dead weight.
        if route.seq == 0 && route.visible_viewers.is_empty() && route.watchers == 0 {
            empty.push(id.clone());
        }
    }
    for id in empty {
        map.remove(&id);
    }
    dropped
}

/// Scope teardown owns the PTY, so no view registration may keep its route
/// alive after the process tree is reaped.
pub fn route_remove_all_views(id: &str) {
    routes().lock().unwrap().remove(id);
}

/// A marker-watcher's hold (`pty_watch`): stream this PTY as if visible.
pub fn route_watch(app: &AppHandle, id: &str) {
    let mut map = routes().lock().unwrap();
    let route = map.entry(id.to_string()).or_default();
    let was = route.subscribed();
    route.watchers += 1;
    if !was {
        emit_replay(app, id, route);
    }
}

/// Release a watch. Unbalanced releases are harmless (saturating), and a
/// watch leaked by a webview reload merely leaves the PTY streaming — today's
/// behaviour, the fail-open direction.
pub fn route_unwatch(id: &str) {
    let mut map = routes().lock().unwrap();
    if let Some(route) = map.get_mut(id) {
        route.watchers = route.watchers.saturating_sub(1);
    }
}

// ── Public data types ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtyOptions {
    pub id: String,
    pub cmd: String,
    pub args: Vec<String>,
    #[serde(default)]
    pub env: std::collections::HashMap<String, String>,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    /// When true, never rewrite this spawn to run over ssh even if its `cwd`
    /// lives under a remote project's mountpoint. Set for locally-bound tabs
    /// (e.g. Ollama `local_agent` tabs that depend on local `VIBE_HOME`).
    #[serde(default)]
    pub local_only: bool,
    /// When true, run this (agent) tab inside a Docker sandbox that mounts only
    /// the project directory. Set by the frontend only for `kind:"agent"` tabs
    /// of a project whose sandbox toggle is enabled. See `services::sandbox`.
    #[serde(default)]
    pub sandbox: bool,
    /// Restriction-only declaration that this renderer tab is an agent.  The
    /// backend also recognises known agent binaries; this covers custom/local
    /// agent launchers whose command name alone is not classifiable.
    #[serde(default)]
    pub agent: bool,
    /// The owning project's id, set by the frontend for tabs that belong to a
    /// project scope (not the root scope). It makes remoteness **explicit**: the
    /// ssh-wrap spawn path resolves the project's `RemoteSpec` from this id (via
    /// `services::remote::remote_target_for`) instead of sniffing whether `cwd`
    /// lives under the sshfs mounts root. `None` for root/connection terminals
    /// (and any spawn path not yet updated), where the cwd-sniffing fallback
    /// still applies. Harmless for local projects — they resolve to no remote.
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub schedule_target_id: Option<String>,
    /// The root console's **Host session**: an agent that runs unfenced, with
    /// the user's full rights, in Tabtivity's `host` agent home
    /// (`docs/context/agent_authority.md`). Honoured only with no
    /// `project_id`; a project tab that sets it is fenced like any other.
    #[serde(default)]
    pub host_session: bool,
    /// Which of the project's remote hosts this tab runs on
    /// (`docs/multi_host_remote_plan.md`): `None`/`"primary"` = the primary remote
    /// (`Project.remote`), any other id = an extra "worker" host from
    /// `compute_hosts`. Set by the frontend from the tab's `host:<id>` location.
    /// Ignored for a local project (resolves to no remote).
    #[serde(default)]
    pub remote_host_id: Option<String>,
    /// Persistent remote session (TODO #85): the **stable tmux session name** to
    /// spawn-or-attach on the host, wrapping the spawn in `tmux new-session -A` so
    /// the run survives an SSH drop / laptop sleep / Tabtivity relaunch. The frontend
    /// mints it once per shell tab and **persists it** (`TabEntry.tmuxSession`), so
    /// it is stable across a relaunch even though the tab's PTY id (`scope:key`) is
    /// regenerated on restore — that stability is what makes reattach work. Set
    /// only for remote shell/script tabs of a persist-enabled project (agent tabs
    /// are excluded — they resume via their own session). `None`/local → no wrap.
    #[serde(default)]
    pub tmux_session: Option<String>,
    /// Attach this tab to an **existing named** tmux session on the host instead
    /// of spawning a fresh one (TODO #85): set when a tab is opened from the
    /// Sessions view onto a running (possibly hand-started) session, and persisted
    /// so the tab reattaches to that same session across a restart. Takes
    /// precedence over `tmux_session` when set. No-op for a local project.
    #[serde(default)]
    pub tmux_attach: Option<String>,
    /// The tab's **host-bound marker id** — the frontend-minted, layout-persisted
    /// uuid of a local-model driver tab that is allowed to run on the host rather
    /// than inside the project's container (`services::sandbox`).
    ///
    /// It is only an *index*: the grant itself is a file under
    /// `<state_dir>/sessions/<project>/host_bound/`, written when the tab is
    /// genuinely created. This replaced keying that decision on the tab's
    /// `TABTIVITY_LOCAL_MODEL` env var, which is a usage-recap label.
    #[serde(default)]
    pub host_bound_uid: Option<String>,
    /// A local-model tab (`kind: "local_agent"`): its agent gets the scope's
    /// local-model home (`services::agent_home::local_model_home`) instead of
    /// the scope's own, so an Ollama launch's config and sessions stay apart.
    /// Chooses a home only; it grants nothing — both homes are fenced alike.
    #[serde(default)]
    pub local_model: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutput {
    pub id: String,
    pub data: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_offset: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_offset: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalScrollback {
    pub data: String,
    pub start_offset: u64,
    pub end_offset: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TerminalExit {
    pub id: String,
    pub code: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TerminalReady {
    pub id: String,
}

// ── Internal entry ─────────────────────────────────────────────────────────

struct PtyEntry {
    master: Box<dyn MasterPty + Send>,
    input_tx: tokio::sync::mpsc::Sender<Vec<u8>>,
    child: Box<dyn Child + Send + Sync>,
    dead: Arc<AtomicBool>,
    crash_times: Vec<Instant>,
    /// The local folder the process works in (`PreparedLaunch::drop_dir`),
    /// where a file dropped onto the tab lands; `None` for a remote tab.
    drop_dir: Option<String>,
    /// The spawn's sequence number (`PreparedLaunch::spawn_seq`): what its
    /// teardown passes to `launch_prep::on_tab_gone`, so a kill that lands
    /// after a respawn of the same id cannot clear the respawn's state.
    seq: u64,
}

/// Invalidate the cached process tree used for CPU sampling. Called whenever a
/// PTY is spawned or dies so the next `sysstat::descendant_pids` rebuilds rather
/// than reusing a stale walk. `sysstat` is cross-platform (Linux/Windows sample,
/// other OSes return zero), so this is a plain atomic bump everywhere.
fn invalidate_proc_tree_cache() {
    crate::sysstat::invalidate_descendant_cache();
}

/// How aggressively [`reap_child_subtree`] signals a doomed process subtree.
pub(crate) enum ReapMode {
    /// SIGTERM now, then SIGKILL any survivors after a short grace period on a
    /// detached thread. Used on tab close / respawn, where the app stays alive
    /// long enough to deliver the escalation.
    Graceful,
    /// SIGKILL immediately. Used at app exit, where a delayed escalation thread
    /// would be torn down with the process before it could fire.
    Immediate,
    /// SIGTERM now, then SIGKILL whatever is still alive when `grace` runs out —
    /// escalated on the **calling** thread, and returning as soon as the subtree
    /// is gone. This is the mode for an exit-time teardown that must let the
    /// process shut itself down first: [`ReapMode::Graceful`]'s escalation thread
    /// dies with the app before it can fire, and [`ReapMode::Immediate`] never
    /// offers the chance. The caller pays the wait, so keep the grace short.
    ///
    /// The grace is unread on Windows, where `TerminateProcess` is the only
    /// per-pid primitive and every mode reaps immediately.
    GracefulBlocking(#[cfg_attr(not(unix), allow(dead_code))] Duration),
}

/// Best-effort abort of a PTY child's **entire process subtree**.
///
/// `portable_pty`'s [`Child::kill`] signals only the shell leader; anything it
/// spawned (a dev server, a build, a training run) is otherwise orphaned and
/// keeps running after its tab — or the whole app — is gone. So we walk the
/// subtree rooted at the leader and signal every pid. The walk must happen
/// *before* the leader is killed: once it dies its children reparent to init and
/// the tree rooted at its pid is no longer reachable.
///
/// The leader pid is included in the returned set; re-signalling a leader the
/// caller also `Child::kill`s is a harmless no-op (a dead pid yields ESRCH).
pub(crate) fn reap_child_subtree(leader_pid: u32, mode: ReapMode) {
    // Force a fresh process-tree walk rather than reusing a cached CPU sample
    // that may predate a just-spawned child.
    crate::sysstat::invalidate_descendant_cache();
    let subtree = crate::sysstat::descendant_pids(&[leader_pid]);
    reap_pids(subtree, mode);
}

/// Signal a set of pids best-effort. Every pid came from a live process walk
/// moments earlier, so a stale one is expected and ignored (ESRCH on Unix, a
/// failed `OpenProcess` on Windows).
#[cfg(unix)]
fn reap_pids(pids: Vec<u32>, mode: ReapMode) {
    if pids.is_empty() {
        return;
    }
    // SAFETY: `libc::kill` takes no pointers and a real signal number; a stale
    // pid returns ESRCH, which we ignore.
    let signal = |pids: &[u32], sig: libc::c_int| unsafe {
        for &pid in pids {
            libc::kill(pid as libc::pid_t, sig);
        }
    };
    match mode {
        ReapMode::Immediate => signal(&pids, libc::SIGKILL),
        ReapMode::Graceful => {
            signal(&pids, libc::SIGTERM);
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(2));
                signal(&pids, libc::SIGKILL);
            });
        }
        ReapMode::GracefulBlocking(grace) => {
            signal(&pids, libc::SIGTERM);
            let deadline = Instant::now() + grace;
            while Instant::now() < deadline {
                // SAFETY: `kill(pid, 0)` probes existence without signalling.
                let any_alive = pids
                    .iter()
                    .any(|&pid| unsafe { libc::kill(pid as libc::pid_t, 0) } == 0);
                if !any_alive {
                    return;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            signal(&pids, libc::SIGKILL);
        }
    }
}

/// Windows has no SIGTERM/SIGKILL split — `TerminateProcess` is the only per-pid
/// primitive — so both modes reap immediately.
#[cfg(windows)]
fn reap_pids(pids: Vec<u32>, _mode: ReapMode) {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    for pid in pids {
        // SAFETY: the handle is closed before the next iteration; a failed open
        // (the pid already exited) is ignored.
        unsafe {
            if let Ok(handle) = OpenProcess(PROCESS_TERMINATE, false, pid) {
                let _ = TerminateProcess(handle, 1);
                let _ = CloseHandle(handle);
            }
        }
    }
}

#[cfg(not(any(unix, windows)))]
fn reap_pids(_pids: Vec<u32>, _mode: ReapMode) {}

// ── PtyRegistry ───────────────────────────────────────────────────────────

#[derive(Default)]
pub struct PtyRegistry {
    entries: HashMap<String, PtyEntry>,
    /// PTY ids that have been spawned at least once this app run. Never cleared
    /// (ids are unique per tab for the life of the app), so it records whether a
    /// later `spawn_pty` for the same id is a re-spawn — see `spawn_pty`'s
    /// `--session-id` → `--resume` rewrite. Survives webview reloads because the
    /// registry lives in the persistent Rust process, not the renderer.
    seen: HashSet<String>,
}

impl PtyRegistry {
    pub fn insert(
        &mut self,
        id: String,
        master: Box<dyn MasterPty + Send>,
        writer: Box<dyn Write + Send>,
        child: Box<dyn Child + Send + Sync>,
        dead: Arc<AtomicBool>,
        seq: u64,
    ) {
        // A spawn that reuses an id must not leak the previous child process,
        // and must keep its crash history so the crash-loop guard stays armed.
        let crash_times = match self.entries.remove(&id) {
            Some(mut old) => {
                old.dead.store(true, Ordering::SeqCst);
                // A respawn under the same id replaces the old child; reap its
                // whole subtree, not just the leader, so a process it spawned
                // does not survive the tab it belonged to.
                if let Some(pid) = old.child.process_id() {
                    reap_child_subtree(pid, ReapMode::Graceful);
                }
                let _ = old.child.kill();
                old.crash_times
            }
            None => Vec::new(),
        };
        let (input_tx, mut input_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(INPUT_CHANNEL_CAP);
        let writer_dead = dead.clone();
        std::thread::spawn(move || {
            let mut writer = writer;
            while let Some(data) = input_rx.blocking_recv() {
                if writer_dead.load(Ordering::SeqCst) {
                    break;
                }
                if writer.write_all(&data).is_err() {
                    break;
                }
            }
        });
        self.entries.insert(
            id,
            PtyEntry {
                master,
                input_tx,
                child,
                dead,
                crash_times,
                drop_dir: None,
                seq,
            },
        );
        // A new child (and the old one it may have replaced) changes the process
        // tree, so drop the cached descendant-pid set.
        invalidate_proc_tree_cache();
    }

    /// [`Self::insert`] for spawn `seq`, only while it is still the id's
    /// newest spawn and not torn down (`agent_fence::is_current_spawn`).
    /// Spawns of one id are prepared concurrently (a remount respawns while
    /// the old mount's spawn is still in `launch_prep::prepare`) and may finish
    /// out of order; an older one replacing a newer one's PTY left the newer
    /// spawn's registration, tokens and turn binding with no PTY whose
    /// teardown could end them (its own teardown is stale). Checked under the
    /// registry lock, so a newer spawn of the id always inserts after this
    /// one. A refused spawn hands its child back for the caller to end.
    #[allow(clippy::too_many_arguments)]
    pub fn insert_current_spawn(
        &mut self,
        id: String,
        master: Box<dyn MasterPty + Send>,
        writer: Box<dyn Write + Send>,
        child: Box<dyn Child + Send + Sync>,
        dead: Arc<AtomicBool>,
        seq: u64,
    ) -> Result<(), Box<dyn Child + Send + Sync>> {
        if !crate::services::agent_fence::is_current_spawn(&id, seq) {
            return Err(child);
        }
        self.insert(id, master, writer, child, dead, seq);
        Ok(())
    }

    /// Record where a file dropped onto the live tab `id` lands.
    pub fn set_drop_dir(&mut self, id: &str, dir: Option<String>) {
        if let Some(entry) = self.entries.get_mut(id) {
            entry.drop_dir = dir;
        }
    }

    /// `None` when no such tab is live; `Some(None)` for a remote one.
    pub fn drop_dir(&self, id: &str) -> Option<Option<String>> {
        self.entries.get(id).map(|e| e.drop_dir.clone())
    }

    pub fn input_sender(&self, id: &str) -> Option<tokio::sync::mpsc::Sender<Vec<u8>>> {
        self.entries.get(id).map(|e| e.input_tx.clone())
    }

    pub fn ids_for_scope(&self, scope: &str) -> Vec<String> {
        self.entries
            .keys()
            .filter(|id| pty_id_in_scope(id, scope))
            .cloned()
            .collect()
    }

    /// Kill one PTY and its process subtree: [`Self::take`] plus
    /// [`TakenPty::teardown`]. Holds `self` for the whole teardown, a full
    /// process-table walk included — callers that share the registry behind a
    /// lock should `take` under it and tear down after releasing it.
    pub fn kill(&mut self, id: &str) {
        if let Some(taken) = self.take(id) {
            taken.teardown();
        }
    }

    /// Remove a PTY from the registry and mark it dead, leaving the teardown
    /// (process-tree walk, signals, per-tab cleanups) to the caller.
    ///
    /// Exists because the registry lock is on the keystroke path: `pty_write`
    /// takes it to find the input channel, for every key in every tab. Tearing
    /// down under it — a `/proc` walk per closed tab — stalled typing in every
    /// other tab for as long as a tab (or a whole project's tabs, one walk
    /// each) took to close.
    pub fn take(&mut self, id: &str) -> Option<TakenPty> {
        let entry = self.entries.remove(id)?;
        entry.dead.store(true, Ordering::SeqCst);
        Some(TakenPty { id: id.to_string(), entry })
    }

    /// Abort every live PTY and its process subtree. Called once at app exit so
    /// no terminal's inner process (a dev server, a build, a training run)
    /// outlives Tabtivity — dropping the registry alone kills only the shell
    /// leaders and orphans everything they spawned. Uses [`ReapMode::Immediate`]
    /// because a delayed escalation thread would die with the exiting process.
    pub fn kill_all(&mut self) {
        // One process-tree walk over all leaders (their subtrees include the
        // leader pids themselves, which `child.kill()` below re-kills harmlessly).
        let leaders: Vec<u32> = self
            .entries
            .values()
            .filter_map(|e| e.child.process_id())
            .collect();
        crate::sysstat::invalidate_descendant_cache();
        let subtree = crate::sysstat::descendant_pids(&leaders);

        for (id, mut e) in self.entries.drain() {
            e.dead.store(true, Ordering::SeqCst);
            let _ = e.child.kill();
            // Containerized tab: also TERM the in-container process (the docker
            // exec client we just killed is not it).
            crate::services::sandbox::kill_tab_process(&id);
            crate::services::launch_prep::on_tab_gone(&id, e.seq);
        }
        reap_pids(subtree, ReapMode::Immediate);
        invalidate_proc_tree_cache();
    }

    /// True when any live (not-yet-dead) PTY belongs to `scope`. PTY ids are
    /// `<scope>:<tab-key>` (CenterPanel), so a prefix match is authoritative.
    /// Used by the project-container teardown to keep a deactivated project's
    /// container alive while background tabs still run inside it.
    pub fn any_live_for_scope(&self, scope: &str) -> bool {
        self.entries
            .iter()
            .any(|(id, e)| pty_id_in_scope(id, scope) && !e.dead.load(Ordering::SeqCst))
    }

    /// OS process id of the child for `id`, if it is still tracked.
    pub fn pid(&self, id: &str) -> Option<u32> {
        self.entries.get(id).and_then(|e| e.child.process_id())
    }

    pub fn check_crash_loop(&mut self, id: &str) -> bool {
        let Some(entry) = self.entries.get_mut(id) else {
            return true;
        };
        let now = Instant::now();
        entry
            .crash_times
            .retain(|t| now.duration_since(*t) < Duration::from_secs(10));
        if entry.crash_times.len() >= CRASH_LOOP_THRESHOLD {
            return false;
        }
        entry.crash_times.push(now);
        true
    }
}

/// A PTY [`PtyRegistry::take`]n out of the registry, still to be torn down.
pub struct TakenPty {
    id: String,
    entry: PtyEntry,
}

impl TakenPty {
    /// Tear this one PTY down; see [`teardown_taken`].
    pub fn teardown(self) {
        teardown_taken(vec![self]);
    }
}

/// Tear down PTYs taken out of the registry: abort each child's whole process
/// subtree, not just the shell leader — `child.kill()` reaps only the leader,
/// so a long-running descendant (a dev server, a build, a training run) would
/// otherwise be orphaned and keep running after its tab closes. The subtrees
/// are gathered first (they are unreachable once a leader dies and its
/// children reparent to init), in ONE process-table walk for all of them, so
/// closing a project's ten tabs costs one walk rather than ten.
pub fn teardown_taken(taken: Vec<TakenPty>) {
    if taken.is_empty() {
        return;
    }
    let leaders: Vec<u32> = taken.iter().filter_map(|t| t.entry.child.process_id()).collect();
    if !leaders.is_empty() {
        // Fresh walk: a cached set may predate a just-spawned child.
        crate::sysstat::invalidate_descendant_cache();
        reap_pids(crate::sysstat::descendant_pids(&leaders), ReapMode::Graceful);
    }
    for TakenPty { id, mut entry } in taken {
        let _ = entry.child.kill();
        // This spawn's per-tab state — fence registration, proxy tokens, MCP
        // tokens, turn binding — unless a respawn of the id has begun since.
        // Then the respawn owns the id's Codex tracking and its in-container
        // process record as well (`sandbox::register_exec_tab` already ended
        // this spawn's in-container process when it replaced the record, and
        // a respawn that fails first ends it in `launch_prep`), so a stale
        // kill touches neither.
        if crate::services::launch_prep::on_tab_gone(&id, entry.seq) {
            // The tab is gone for good, so stop watching for its Codex session.
            crate::services::codex_bind::untrack_now(&id);
            // Containerized tab: killing the child above only killed the
            // `docker exec` CLIENT — TERM the process inside the container too
            // (best-effort, no-op for tabs that never containerized).
            crate::services::sandbox::kill_tab_process(&id);
        }
    }
    // The tree shrank; drop the cached descendant-pid set.
    invalidate_proc_tree_cache();
}

fn pty_id_in_scope(id: &str, scope: &str) -> bool {
    id.strip_prefix(scope)
        .is_some_and(|suffix| suffix.starts_with(':'))
}

// ── Spawn ─────────────────────────────────────────────────────────────────

/// Spawn a PTY and wire up Tauri event emission.
/// The read loop runs in a std::thread (blocking I/O) and passes chunks
/// through an mpsc channel to a Tokio task that batches and emits events.
pub fn spawn_pty(
    app: AppHandle,
    registry: Arc<Mutex<PtyRegistry>>,
    opts: PtyOptions,
    seq: u64,
) -> Result<(), String> {
    // Record this PTY id so a later remount (HMR, webview reload) is a known
    // re-spawn. Agent-session resolution (Claude/Codex resume args) happens in
    // the caller (`commands::terminal::pty_spawn`) *before* any ssh wrapping, so
    // remote agent tabs resume correctly; by the time the command reaches here it
    // is fully resolved (and possibly already rewritten to `ssh`).
    registry.lock().unwrap().seen.insert(opts.id.clone());

    let pty_system = NativePtySystem::default();

    // Never open a zero-size PTY. A 0-col/0-row size can slip in if the caller
    // spawns before xterm has measured a layout box; Unix ptys tolerate it but
    // Windows ConPTY accepts it silently and then emits no output, which shows up
    // as a black, dead agent tab. Clamp to a sane default so the child always has
    // a usable window — the frontend re-sends the real size via `pty_resize` as
    // soon as the pane is fitted.
    let cols = if opts.cols == 0 { 80 } else { opts.cols };
    let rows = if opts.rows == 0 { 24 } else { opts.rows };

    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {e}"))?;

    let cmd = build_command(&opts);
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn: {e}"))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take writer: {e}"))?;

    let dead = Arc::new(AtomicBool::new(false));
    let refused = registry
        .lock()
        .unwrap()
        .insert_current_spawn(opts.id.clone(), pair.master, writer, child, dead.clone(), seq)
        .err();
    if let Some(mut child) = refused {
        if let Some(pid) = child.process_id() {
            reap_child_subtree(pid, ReapMode::Graceful);
        }
        let _ = child.kill();
        return Err(format!(
            "terminal '{}': a newer start of this tab replaced this one",
            opts.id
        ));
    }

    let _ = app.emit(
        "terminal-ready",
        TerminalReady {
            id: opts.id.clone(),
        },
    );

    // Channel: blocking reader thread → async emitter task.
    let (tx, rx) = tokio::sync::mpsc::channel::<Vec<u8>>(CHANNEL_CAP);

    let dead_reader = dead.clone();
    let _id_reader = opts.id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            if dead_reader.load(Ordering::SeqCst) {
                break;
            }
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    // This is a dedicated reader thread, so blocking here is the
                    // correct bounded-backpressure behaviour: the OS PTY buffer
                    // slows the child rather than silently losing terminal bytes.
                    if tx.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        // Signal EOF by dropping tx.
    });

    let id = opts.id.clone();
    // Token for this *particular* spawn's Codex session tracking (None for any
    // tab the binder isn't following). A re-spawn under the same id replaces the
    // tracking and mints a new token, so the old process exiting below can only
    // ever tear down its own.
    let bind_seq = crate::services::codex_bind::current_seq(&opts.id);
    let resume_seq = crate::services::codex_bind::resume_seq(&opts.id);
    let route_seq = seq;
    route_open_at(&opts.id, route_seq);
    let mcp_token = opts.env.get(crate::services::root_mcp::TOKEN_ENV)
        .or_else(|| opts.env.get(crate::services::root_mcp::SCHEDULE_TOKEN_ENV)).cloned();
    let help_token = opts.env.get(crate::services::root_mcp::HELP_TOKEN_ENV).cloned();
    let push_token = opts.env.get(crate::services::root_mcp::GIT_TOKEN_ENV).cloned();
    let markup_token = opts.env.get(crate::services::root_mcp::MARKUP_TOKEN_ENV).cloned();
    tokio::spawn(async move {
        let emitter = app.clone();
        batch_output(rx, |bytes| match route_chunk(&id, bytes, route_seq) {
            Routed::Data(slice) => emit_output(&emitter, "terminal-output", &id, slice),
            Routed::Activity(text) => {
                let _ = emitter.emit(
                    "terminal-activity",
                    TerminalOutput {
                        id: id.clone(),
                        data: text,
                        start_offset: None,
                        end_offset: None,
                    },
                );
            }
            Routed::ArmDigest(deadline) => {
                // A short-lived task per digest window, only while a hidden PTY
                // is mid-burst — an idle or visible PTY arms nothing, keeping
                // the zero-idle-wakeups discipline of `batch_output` intact.
                let app2 = emitter.clone();
                let id2 = id.clone();
                tokio::spawn(async move {
                    tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)).await;
                    if let Some(text) = route_digest_take(&id2) {
                        let _ = app2.emit(
                            "terminal-activity",
                            TerminalOutput {
                                id: id2,
                                data: text,
                                start_offset: None,
                                end_offset: None,
                            },
                        );
                    }
                });
            }
            Routed::Quiet => {}
        })
        .await;
        match route_finish(&id, route_seq) {
            Routed::Data(slice) => emit_output(&emitter, "terminal-output", &id, slice),
            Routed::Activity(text) => {
                let _ = emitter.emit(
                    "terminal-activity",
                    TerminalOutput {
                        id: id.clone(),
                        data: text,
                        start_offset: None,
                        end_offset: None,
                    },
                );
            }
            Routed::ArmDigest(_) | Routed::Quiet => {}
        }
        // A tab can be respawned before the prior reader task observes EOF
        // (Strict Mode/HMR and mode switches all reuse its PTY id). That old
        // task must not announce its own exit into the replacement terminal.
        let current_spawn_ended = route_close(&id, route_seq);
        // The child exited on its own; its subtree is gone, so the next CPU
        // sample must rebuild rather than count dead pids.
        invalidate_proc_tree_cache();
        // Codex quit by itself (`/exit`, crash) — stop watching for its session.
        if let Some(seq) = bind_seq {
            crate::services::codex_bind::untrack(&id, seq);
        }
        if let Some(seq) = resume_seq {
            crate::services::codex_bind::release_resume(&id, seq);
        }
        if current_spawn_ended {
            crate::services::agent_fence::on_tab_gone(&id, route_seq);
            if let Some(token) = help_token {
                crate::services::root_mcp::revoke_token(&token);
            }
            if let Some(token) = push_token {
                crate::services::root_mcp::revoke_token(&token);
                let _ = app.emit(crate::services::git_push_mcp::CHANGED_EVENT, ());
            }
            if let Some(token) = markup_token {
                // The tab's open markup question goes with its session; the
                // sweep rings `markup-mcp-changed` through the change hook.
                crate::services::root_mcp::revoke_token(&token);
                crate::services::markup_mcp::sweep();
            }
            if let Some(token) = mcp_token {
                let state = crate::storage::state_dir();
                crate::services::root_mcp_review::on_spawn_gone(&state, &token);
                let _ = app.emit("root-mcp-review-changed", crate::services::root_mcp_review::pending_count(&state));
            }
            let _ = app.emit("terminal-exit", TerminalExit { id, code: None });
        }
    });

    Ok(())
}

/// Drain a PTY's output channel into batched `flush` calls.
///
/// The wakeup discipline is the whole point (typing-latency plan, step 2): an
/// idle terminal must cost **zero** timer wakeups. The old loop re-armed a
/// 16 ms `timeout` unconditionally, so every idle tab woke a tokio task
/// 62.5×/s forever — with ~50 open PTYs that alone was ~647 context switches
/// per second at rest. The rules:
///
/// - Batch empty → park on `recv()` with no timer at all.
/// - A chunk arriving with `last_emit` a full window ago flushes immediately —
///   the leading edge. This is every keystroke echo at typing speed (inter-key
///   gaps far exceed the window), so echo latency stays ~0 ms.
/// - A chunk arriving inside the window arms one timeout for the *remainder*
///   of the window, coalescing a burst; a batch reaching `BATCH_MAX_BYTES`
///   flushes before the window ends. That early flush only coalesces anything
///   because the cap is several reader-buffer reads deep — see the constant.
async fn batch_output<F: FnMut(&[u8])>(mut rx: tokio::sync::mpsc::Receiver<Vec<u8>>, mut flush: F) {
    // Small initial capacity, grown on demand: this runs once per PTY and the
    // preallocation is eager, so reserving the full `BATCH_MAX_BYTES` would pin
    // ~32 KiB per idle tab (≈1.6 MB across a 50-tab session) for nothing.
    let mut batch: Vec<u8> = Vec::with_capacity(8192);
    // Start stale by one full window so the very first chunk takes the
    // leading-edge flush too (checked_sub: an Instant can't go below the
    // platform's epoch; the fallback merely delays the first flush one window).
    let mut last_emit = Instant::now()
        .checked_sub(BATCH_INTERVAL)
        .unwrap_or_else(Instant::now);

    loop {
        if batch.is_empty() {
            match rx.recv().await {
                Some(data) => batch.extend_from_slice(&data),
                None => break, // Channel closed = reader thread exited.
            }
        } else {
            let deadline = tokio::time::Instant::from_std(last_emit + BATCH_INTERVAL);
            match tokio::time::timeout_at(deadline, rx.recv()).await {
                Ok(Some(data)) => batch.extend_from_slice(&data),
                Ok(None) => break,
                Err(_expired) => {} // Window over with data pending: flush below.
            }
        }

        let now = Instant::now();
        let should_flush = !batch.is_empty()
            && (batch.len() >= BATCH_MAX_BYTES || now.duration_since(last_emit) >= BATCH_INTERVAL);

        if should_flush {
            flush(&batch);
            batch.clear();
            last_emit = now;
        }
    }

    // Final flush.
    if !batch.is_empty() {
        flush(&batch);
    }
}

/// Resize an existing PTY.
pub fn resize_pty(
    registry: &Arc<Mutex<PtyRegistry>>,
    id: &str,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let mut reg = registry.lock().unwrap();
    let Some(entry) = reg.entries.get_mut(id) else {
        return Ok(());
    };

    entry
        .master
        .resize(PtySize {
            cols,
            rows,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize: {e}"))
}

// ── Shell detection ────────────────────────────────────────────────────────

/// Return the user's preferred login shell, falling back to a platform default.
pub fn default_shell() -> String {
    if cfg!(target_os = "windows") {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    } else if cfg!(target_os = "macos") {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

// ── Command builder ────────────────────────────────────────────────────────

/// Wrap a resolved absolute executable path into a `CommandBuilder`. A `.exe`
/// (or a Unix binary) runs directly; a `.cmd`/`.bat` shim (npm-style) needs
/// `cmd.exe /c` and a `.ps1` needs PowerShell, since `CreateProcess` can't exec
/// those directly inside the PTY.
fn command_for_resolved(path: std::path::PathBuf) -> CommandBuilder {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    match ext.as_deref() {
        Some("cmd") | Some("bat") => {
            let mut c = CommandBuilder::new("cmd.exe");
            c.arg("/D");
            c.arg("/C");
            c.arg(path);
            c
        }
        Some("ps1") => {
            let mut c = CommandBuilder::new("powershell.exe");
            c.arg("-NoProfile");
            c.arg("-ExecutionPolicy");
            c.arg("Bypass");
            c.arg("-File");
            c.arg(path);
            c
        }
        _ => CommandBuilder::new(path),
    }
}

fn build_command(opts: &PtyOptions) -> CommandBuilder {
    let cmd_str = if opts.cmd.is_empty() {
        default_shell()
    } else {
        opts.cmd.clone()
    };
    // A bare tool name (e.g. "vibe"/"ollama") that Tabtivity detected as installed
    // may still not be launchable on Windows: winget/uv/npm install into per-user
    // dirs (%LOCALAPPDATA%\Programs, %USERPROFILE%\.local\bin, %APPDATA%\npm, …)
    // that the PATH this process inherited often omits. Resolve to an absolute
    // path so the spawn finds it. No-op when the name already resolves on PATH or
    // carries a path — so ssh/docker-wrapped tabs (cmd "ssh"/"docker", both on
    // PATH) keep their remote/in-container binary names, which live in `args`.
    // Tabtivity's own helpers (the `ssh` of a remote tab, the local `tmux`) come
    // from the root-owned system dirs first, never a user-writable one (#861).
    let resolved = crate::paths::helper_program(std::ffi::OsStr::new(&cmd_str))
        .or_else(|| crate::paths::resolve_offpath_binary(&cmd_str));
    let mut cmd = match resolved {
        Some(resolved) => command_for_resolved(resolved),
        None => CommandBuilder::new(&cmd_str),
    };
    for arg in &opts.args {
        cmd.arg(arg);
    }
    cmd.cwd(&opts.cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if let Some(path) = crate::paths::effective_path() {
        cmd.env("PATH", path);
    }
    for (k, v) in &opts.env {
        cmd.env(k, v);
    }

    #[cfg(target_os = "linux")]
    {
        cmd.env_remove("GIO_LAUNCHED_DESKTOP_FILE");
        cmd.env_remove("GIO_LAUNCHED_DESKTOP_FILE_PID");
        // Tabtivity's own AT-SPI opt-out is about Tabtivity's window (see
        // `services::webkit_a11y`); inherited, it would silently strip
        // accessibility from any other WebKitGTK app a tab launches. Dropped
        // only when Tabtivity set it — an address the user exported stays.
        if crate::services::webkit_a11y::installed() {
            cmd.env_remove(crate::services::webkit_a11y::BUS_ADDRESS_VAR);
        }
        // Same for the GPU-decoder demotion (`services::webkit_video`): it is
        // for Tabtivity's software-painted window, not a player a tab launches.
        if crate::services::webkit_video::installed() {
            cmd.env_remove(crate::services::webkit_video::RANK_VAR);
        }
    }

    cmd
}

#[cfg(test)]
mod batch_tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    type Flushes = Arc<Mutex<Vec<Vec<u8>>>>;

    /// Spawn `batch_output` collecting flushes into a shared list.
    fn collectors() -> (
        tokio::sync::mpsc::Sender<Vec<u8>>,
        Flushes,
        tokio::task::JoinHandle<()>,
    ) {
        let (tx, rx) = tokio::sync::mpsc::channel::<Vec<u8>>(CHANNEL_CAP);
        let flushes: Flushes = Arc::new(Mutex::new(Vec::new()));
        let sink = flushes.clone();
        let handle = tokio::spawn(async move {
            batch_output(rx, |bytes| sink.lock().unwrap().push(bytes.to_vec())).await;
        });
        (tx, flushes, handle)
    }

    /// Let the batcher task run without advancing the paused clock: yielding
    /// keeps this task ready, so tokio's auto-advance never fires.
    async fn settle() {
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
    }

    /// The keystroke-echo invariant: the first chunk after quiet flushes with
    /// no batching delay at all. The clock is paused, so if the batcher waited
    /// on any timer the flush could not have happened yet.
    #[tokio::test(start_paused = true)]
    async fn first_chunk_after_quiet_flushes_immediately() {
        let (tx, flushes, _h) = collectors();
        tx.send(b"x".to_vec()).await.unwrap();
        settle().await;
        assert_eq!(*flushes.lock().unwrap(), vec![b"x".to_vec()]);
    }

    /// Chunks landing inside the window coalesce into one flush at the
    /// window's trailing edge — not one emit per chunk.
    #[tokio::test(start_paused = true)]
    async fn mid_burst_chunks_coalesce_until_window() {
        let (tx, flushes, _h) = collectors();
        tx.send(b"a".to_vec()).await.unwrap();
        settle().await; // leading-edge flush of "a"; window opens now
        tx.send(b"b".to_vec()).await.unwrap();
        settle().await;
        tx.send(b"c".to_vec()).await.unwrap();
        settle().await;
        // Sleeping past the window lets the paused clock auto-advance to the
        // batcher's armed deadline.
        tokio::time::sleep(BATCH_INTERVAL * 2).await;
        settle().await;
        assert_eq!(
            *flushes.lock().unwrap(),
            vec![b"a".to_vec(), b"bc".to_vec()]
        );
    }

    /// A full batch flushes immediately even inside the window.
    #[tokio::test(start_paused = true)]
    async fn max_bytes_flushes_inside_window() {
        let (tx, flushes, _h) = collectors();
        tx.send(b"a".to_vec()).await.unwrap();
        settle().await;
        tx.send(vec![b'z'; BATCH_MAX_BYTES]).await.unwrap();
        settle().await; // clock never advanced: only the size rule can flush
        assert_eq!(flushes.lock().unwrap().len(), 2);
        assert_eq!(flushes.lock().unwrap()[1].len(), BATCH_MAX_BYTES);
    }

    /// Data pending when the channel closes is not lost.
    #[tokio::test(start_paused = true)]
    async fn close_flushes_remainder() {
        let (tx, flushes, h) = collectors();
        tx.send(b"a".to_vec()).await.unwrap();
        settle().await;
        tx.send(b"tail".to_vec()).await.unwrap(); // inside the window: batched
        settle().await;
        drop(tx);
        h.await.unwrap();
        assert_eq!(
            *flushes.lock().unwrap(),
            vec![b"a".to_vec(), b"tail".to_vec()]
        );
    }
}

#[cfg(test)]
mod route_tests {
    use super::*;

    /// Flip a route's visibility without an AppHandle (the command wrapper's
    /// only extra is the replay emit); returns what that emit would carry.
    fn set_visible(id: &str, visible: bool) -> Option<String> {
        let mut map = routes().lock().unwrap();
        let route = map.entry(id.to_string()).or_default();
        let was = route.subscribed();
        route
            .visible_viewers
            .insert("test-view".to_string(), viewer(visible, "main"));
        if !was && route.subscribed() {
            route.take_pending().map(|slice| slice.text)
        } else {
            None
        }
    }

    /// A viewer registration for the tests (the window label only matters to
    /// `route_drop_window_views`).
    fn viewer(visible: bool, window: &str) -> ViewerReg {
        ViewerReg {
            visible,
            seq: 1,
            window: window.to_string(),
        }
    }

    #[test]
    fn registered_view_streams_data() {
        let id = "route-t-default";
        let seq = route_open(id);
        set_visible(id, true);
        assert!(matches!(
            route_chunk_at(id, b"hello", Instant::now(), seq),
            Routed::Data(t) if t.text == "hello"
        ));
        set_visible(id, false);
        route_remove_view(id, "test-view", 2);
        route_close(id, seq);
    }

    #[test]
    fn hidden_digests_leading_edge_then_coalesces() {
        let id = "route-t-digest";
        let seq = route_open(id);
        assert_eq!(set_visible(id, false), None);
        let t0 = Instant::now();
        // First hidden chunk: leading-edge digest, no batching delay.
        assert!(matches!(
            route_chunk_at(id, b"abc", t0, seq),
            Routed::Activity(t) if t == "abc"
        ));
        // Inside the window: buffered, one trailing flush armed at the window end.
        assert!(matches!(
            route_chunk_at(id, b"def", t0 + Duration::from_millis(10), seq),
            Routed::ArmDigest(d) if d == t0 + ACTIVITY_INTERVAL
        ));
        assert!(matches!(
            route_chunk_at(id, b"ghi", t0 + Duration::from_millis(20), seq),
            Routed::Quiet
        ));
        // The trailing flush drains what the window accumulated — the decision
        // prompt that arrived right before quiet is never stranded.
        assert_eq!(
            route_digest_take_at(id, t0 + ACTIVITY_INTERVAL).as_deref(),
            Some("defghi")
        );
        assert_eq!(route_digest_take_at(id, t0 + ACTIVITY_INTERVAL), None);
        route_remove_view(id, "test-view", 2);
        route_close(id, seq);
    }

    #[test]
    fn showing_replays_every_hidden_byte_once() {
        let id = "route-t-replay";
        let seq = route_open(id);
        set_visible(id, false);
        let t0 = Instant::now();
        let _ = route_chunk_at(id, b"abc", t0, seq);
        let _ = route_chunk_at(id, b"def", t0 + Duration::from_millis(10), seq);
        // The replay carries ALL hidden bytes — including those a digest
        // already summarized (the digest fed the pills, not the pane).
        assert_eq!(set_visible(id, true).as_deref(), Some("abcdef"));
        // And streaming resumes.
        assert!(matches!(
            route_chunk_at(id, b"live", Instant::now(), seq),
            Routed::Data(t) if t.text == "live"
        ));
        // No leftover digest fires after the drain.
        assert_eq!(route_digest_take_at(id, t0 + ACTIVITY_INTERVAL), None);
        route_remove_view(id, "test-view", 2);
        route_close(id, seq);
    }

    #[test]
    fn a_watch_streams_a_hidden_pty() {
        let id = "route-t-watch";
        let seq = route_open(id);
        set_visible(id, false);
        let t0 = Instant::now();
        let _ = route_chunk_at(id, b"early", t0, seq);
        // Rising edge drains pending (byte order across the watch) …
        {
            let mut map = routes().lock().unwrap();
            let route = map.get_mut(id).unwrap();
            let was = route.subscribed();
            route.watchers += 1;
            assert!(!was);
            assert_eq!(route.take_pending().map(|slice| slice.text).as_deref(), Some("early"));
        }
        // … then the hidden PTY streams like a visible one.
        assert!(matches!(
            route_chunk_at(id, b"marker", Instant::now(), seq),
            Routed::Data(t) if t.text == "marker"
        ));
        route_unwatch(id);
        // Released: back to buffering (leading-edge digest again).
        assert!(matches!(
            route_chunk_at(id, b"after", t0 + ACTIVITY_INTERVAL * 2, seq),
            Routed::Activity(t) if t == "after"
        ));
        route_remove_view(id, "test-view", 2);
        route_close(id, seq);
    }

    #[test]
    fn pending_is_capped_with_hysteresis() {
        let mut buf = "x".repeat(ROUTE_PENDING_CAP * 2);
        trim_with_hysteresis(&mut buf, ROUTE_PENDING_CAP);
        assert_eq!(buf.len(), ROUTE_PENDING_CAP * 2, "at 2x nothing is cut yet");
        buf.push('y');
        trim_with_hysteresis(&mut buf, ROUTE_PENDING_CAP);
        assert_eq!(
            buf.len(),
            ROUTE_PENDING_CAP,
            "past 2x it cuts back to the cap"
        );
        assert!(buf.ends_with('y'), "the newest bytes survive");
    }

    #[test]
    fn one_hidden_view_cannot_silence_another_visible_view() {
        let id = "route-t-two-views";
        let seq = route_open(id);
        {
            let mut map = routes().lock().unwrap();
            let route = map.get_mut(id).unwrap();
            route
                .visible_viewers
                .insert("main".to_string(), viewer(false, "main"));
            route
                .visible_viewers
                .insert("detached".to_string(), viewer(true, "detached-p-g-1"));
        }
        assert!(matches!(
            route_chunk_at(id, b"still-live", Instant::now(), seq),
            Routed::Data(t) if t.text == "still-live"
        ));
        {
            let mut map = routes().lock().unwrap();
            map.get_mut(id).unwrap().visible_viewers.remove("detached");
            map.get_mut(id).unwrap().visible_viewers.remove("main");
        }
        route_close(id, seq);
    }

    /// Group B #238: a popout is always torn down with `destroy()`, which runs
    /// no renderer cleanup — so its panes never call `pty_remove_view` and the
    /// route was left holding a `visible: true` viewer for a window that no
    /// longer exists. The PTY then streams over IPC forever. The `Destroyed`
    /// hook drops the whole window's registrations instead.
    #[test]
    fn dropping_a_dead_windows_views_unsubscribes_its_ptys() {
        let id = "route-t-window-drop";
        let seq = route_open(id);
        {
            let mut map = routes().lock().unwrap();
            let route = map.get_mut(id).unwrap();
            route
                .visible_viewers
                .insert("main-view".to_string(), viewer(false, "main"));
            route
                .visible_viewers
                .insert("popout-view".to_string(), viewer(true, "detached-p-g-2"));
        }
        // While the popout's view is registered the PTY streams…
        assert!(matches!(
            route_chunk_at(id, b"live", Instant::now(), seq),
            Routed::Data(_)
        ));

        // Its own window label: the drop sweeps every route, and the other
        // route tests run in parallel.
        assert_eq!(route_drop_window_views("detached-p-g-2"), 1);

        // …and once its window is gone it goes back to buffering, exactly as it
        // would have if the pane had unmounted properly. The main window's own
        // (hidden) view is untouched.
        assert!(!matches!(
            route_chunk_at(id, b"after", Instant::now(), seq),
            Routed::Data(_)
        ));
        {
            let map = routes().lock().unwrap();
            let route = map.get(id).unwrap();
            assert!(route.visible_viewers.contains_key("main-view"));
            assert!(!route.visible_viewers.contains_key("popout-view"));
        }
        {
            let mut map = routes().lock().unwrap();
            map.get_mut(id).unwrap().visible_viewers.remove("main-view");
        }
        route_close(id, seq);
    }

    /// A chunk names each popout with a view of the PTY (shown or hidden) once,
    /// and never the main window, which gets every chunk under the plain event.
    #[test]
    fn a_streamed_chunk_names_the_popouts_viewing_it() {
        let id = "route-t-chunk-windows";
        let seq = route_open(id);
        {
            let mut map = routes().lock().unwrap();
            let route = map.get_mut(id).unwrap();
            route.visible_viewers.insert("main-view".to_string(), viewer(true, "main"));
            route
                .visible_viewers
                .insert("pop-a".to_string(), viewer(true, "detached-p-g-3"));
            route
                .visible_viewers
                .insert("pop-b".to_string(), viewer(false, "detached-p-g-3"));
        }
        match route_chunk_at(id, b"live", Instant::now(), seq) {
            Routed::Data(slice) => assert_eq!(slice.windows, vec!["detached-p-g-3".to_string()]),
            other => panic!("expected data, got {other:?}"),
        }
        {
            let mut map = routes().lock().unwrap();
            let route = map.get_mut(id).unwrap();
            route.visible_viewers.remove("pop-a");
            route.visible_viewers.remove("pop-b");
        }
        match route_chunk_at(id, b"main-only", Instant::now(), seq) {
            Routed::Data(slice) => assert!(slice.windows.is_empty()),
            other => panic!("expected data, got {other:?}"),
        }
        routes().lock().unwrap().get_mut(id).unwrap().visible_viewers.remove("main-view");
        route_close(id, seq);
    }

    /// Group B #235: a viewer attaching to a PTY that has already produced
    /// output gets that output, rather than a blank pane that stays blank until
    /// the program next draws. Retained whether or not anyone was watching —
    /// the question is what the terminal has SHOWN, not who saw it — and a read
    /// rather than a drain, so a third window attaching later gets it too.
    #[test]
    fn a_later_viewer_can_catch_up_on_what_already_ran() {
        let id = "route-t-scrollback";
        let seq = route_open(id);
        // Nobody is watching: this is the case that used to leave a popout blank.
        route_chunk_at(id, b"$ ls -la\r\ntotal 0\r\n", Instant::now(), seq);
        set_visible(id, true);
        route_chunk_at(id, b"$ echo hi\r\nhi\r\n", Instant::now(), seq);

        let tail = route_scrollback(id);
        assert!(tail.data.contains("total 0"), "output from before any viewer");
        assert!(tail.data.contains("hi"), "and output produced while visible");
        assert_eq!(route_scrollback(id), tail, "a read, never a drain");

        set_visible(id, false);
        {
            let mut map = routes().lock().unwrap();
            map.get_mut(id).unwrap().visible_viewers.remove("test-view");
        }
        route_close(id, seq);
        // A respawn under the same id is a NEW program: its predecessor's screen
        // is not this one's catch-up.
        let seq2 = route_open(id);
        assert_eq!(route_scrollback(id).data, "");
        route_close(id, seq2);
    }

    #[test]
    fn scrollback_and_live_events_share_one_byte_offset_timeline() {
        let id = "route-t-scrollback-offset";
        let seq = route_open(id);
        set_visible(id, true);
        let first = match route_chunk_at(id, "aé".as_bytes(), Instant::now(), seq) {
            Routed::Data(slice) => slice,
            other => panic!("expected live data, got {other:?}"),
        };
        let snapshot = route_scrollback(id);
        let second = match route_chunk_at(id, b"z", Instant::now(), seq) {
            Routed::Data(slice) => slice,
            other => panic!("expected live data, got {other:?}"),
        };

        assert_eq!((first.start_offset, first.end_offset), (0, 3));
        assert_eq!(snapshot.end_offset, first.end_offset);
        assert_eq!(
            (second.start_offset, second.end_offset),
            (snapshot.end_offset, snapshot.end_offset + 1)
        );

        set_visible(id, false);
        route_remove_view(id, "test-view", 2);
        route_close(id, seq);
    }

    #[test]
    fn the_scrollback_tail_is_bounded() {
        let id = "route-t-scrollback-cap";
        let seq = route_open(id);
        let chunk = "x".repeat(100_000);
        for _ in 0..8 {
            route_chunk_at(id, chunk.as_bytes(), Instant::now(), seq);
        }
        let tail = route_scrollback(id);
        assert!(
            tail.data.len() <= ROUTE_SCROLLBACK_CAP * 2,
            "trimmed with hysteresis, so bounded at 2x the cap: {}",
            tail.data.len()
        );
        route_close(id, seq);
    }

    #[test]
    fn utf8_decoder_preserves_codepoints_across_every_split() {
        let source = "aé€𐍈z";
        for split in 1..source.len() {
            let mut decoder = Utf8StreamDecoder::default();
            let mut decoded = decoder.push(&source.as_bytes()[..split]);
            decoded.push_str(&decoder.push(&source.as_bytes()[split..]));
            decoded.push_str(&decoder.finish());
            assert_eq!(decoded, source, "split at byte {split}");
        }
    }

    #[test]
    fn utf8_decoder_replaces_invalid_or_truncated_input_once() {
        let mut invalid = Utf8StreamDecoder::default();
        assert_eq!(invalid.push(&[b'a', 0xff, b'b']), "a\u{fffd}b");
        assert_eq!(invalid.finish(), "");

        let mut truncated = Utf8StreamDecoder::default();
        assert_eq!(truncated.push(&[0xf0, 0x9f]), "");
        assert_eq!(truncated.finish(), "\u{fffd}");
    }

    #[test]
    fn scope_ids_require_the_colon_boundary() {
        assert!(pty_id_in_scope("project:tab-1", "project"));
        assert!(!pty_id_in_scope("project-two:tab-1", "project"));
        assert!(!pty_id_in_scope("project", "project"));
    }

    #[test]
    fn respawn_survives_the_old_spawns_cleanup() {
        let id = "route-t-respawn";
        let old = route_open(id);
        set_visible(id, false);
        let new = route_open(id);
        assert!(!route_close(id, old), "the old spawn is no longer current");
        assert!(
            routes().lock().unwrap().contains_key(id),
            "the respawn's route must survive"
        );
        // And the respawn kept the pane's hidden state.
        assert!(!routes().lock().unwrap().get(id).unwrap().subscribed());
        route_remove_view(id, "test-view", 2);
        assert!(
            route_close(id, new),
            "the current spawn closes its own route"
        );
        assert!(!routes().lock().unwrap().contains_key(id));
    }

    /// The emit half of the same guard. A superseded spawn drains its PTY for a
    /// while after the replacement opened the route (the reader thread is parked
    /// in `read()` while `insert()` reaps the child), and a TUI writes a whole
    /// teardown frame on its way out. Routed under the shared id, that frame
    /// decoded through the new spawn's decoder and reached its terminal — the
    /// previous tab's screen drawn into the replacement's, each holding part of
    /// the viewport. The old generation must be dropped outright.
    #[test]
    fn a_superseded_spawns_trailing_output_never_reaches_the_replacement() {
        let id = "route-t-stale-output";
        let old = route_open(id);
        set_visible(id, true);
        let new = route_open(id);

        assert!(
            matches!(route_chunk_at(id, b"dying frame", Instant::now(), old), Routed::Quiet),
            "the superseded spawn's output must not be routed"
        );
        assert!(
            matches!(route_finish(id, old), Routed::Quiet),
            "nor its trailing partial codepoint"
        );
        // It must also leave no trace on the replacement's stream: the byte
        // offsets the frontend reconciles scrollback against are per-spawn.
        assert_eq!(route_scrollback(id).end_offset, 0);

        assert!(
            matches!(
                route_chunk_at(id, b"live", Instant::now(), new),
                Routed::Data(slice) if slice.text == "live" && slice.start_offset == 0
            ),
            "the current spawn still streams normally"
        );

        set_visible(id, false);
        route_remove_view(id, "test-view", 2);
        route_close(id, new);
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn resize_pty_updates_kernel_size() {
        let pty_system = NativePtySystem::default();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");

        let mut cmd = CommandBuilder::new("sleep");
        cmd.arg("1");
        let child = pair.slave.spawn_command(cmd).expect("spawn sleep");
        let writer = pair.master.take_writer().expect("take writer");
        let master = pair.master;

        let registry = Arc::new(Mutex::new(PtyRegistry::default()));
        let dead = Arc::new(AtomicBool::new(false));
        {
            let mut reg = registry.lock().unwrap();
            reg.insert("test".to_string(), master, writer, child, dead, 0);
        }

        resize_pty(&registry, "test", 100, 40).expect("resize");

        let reg = registry.lock().unwrap();
        let entry = reg.entries.get("test").expect("entry exists");
        let size = entry.master.get_size().expect("get_size");
        assert_eq!(size.cols, 100);
        assert_eq!(size.rows, 40);
        drop(reg);

        registry.lock().unwrap().kill("test");
    }

    /// A PTY running `sleep 30`, for the registry tests.
    #[allow(clippy::type_complexity)]
    fn sleeper() -> (Box<dyn MasterPty + Send>, Box<dyn Write + Send>, Box<dyn Child + Send + Sync>) {
        let pair = NativePtySystem::default()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .expect("openpty");
        let mut cmd = CommandBuilder::new("sleep");
        cmd.arg("30");
        let child = pair.slave.spawn_command(cmd).expect("spawn sleep");
        let writer = pair.master.take_writer().expect("take writer");
        (pair.master, writer, child)
    }

    /// Gap 18 review: a kill whose teardown lands after a remount began
    /// respawning the id leaves the respawn's Codex resume claim (and its
    /// tracking, removed by the same `untrack_now`).
    #[test]
    fn a_stale_kill_leaves_the_respawns_codex_resume_claim() {
        use crate::services::{agent_fence, codex_bind};
        let id = "gen-reg:codex";
        let mut reg = PtyRegistry::default();
        let old = agent_fence::begin_spawn(id);
        let (master, writer, child) = sleeper();
        assert!(reg.insert_current_spawn(id.into(), master, writer, child, Arc::new(AtomicBool::new(false)), old).is_ok());
        assert!(agent_fence::register_tab(id, None, old));
        // The respawn begins and claims the Codex session it resumes.
        let new = agent_fence::begin_spawn(id);
        let mut opts = PtyOptions {
            id: id.into(), cmd: "codex".into(), args: vec!["resume".into(), "0199aaaa-0000-7000-8000-00000000c0de".into()],
            env: HashMap::new(), cwd: "/p".into(), cols: 80, rows: 24, local_only: false, sandbox: false, agent: true,
            project_id: None, remote_host_id: None, tmux_session: None, tmux_attach: None, host_bound_uid: None,
            local_model: false, schedule_target_id: None, host_session: false,
        };
        codex_bind::reserve_resume(&mut opts).expect("the respawn claims its session").keep();
        let claim = codex_bind::resume_seq(id);
        assert!(claim.is_some());
        reg.take(id).expect("the old PTY").teardown();
        assert_eq!(codex_bind::resume_seq(id), claim, "a stale kill released the respawn's claim");
        // The respawn's own teardown ends it.
        let (master, writer, child) = sleeper();
        assert!(reg.insert_current_spawn(id.into(), master, writer, child, Arc::new(AtomicBool::new(false)), new).is_ok());
        reg.take(id).expect("the new PTY").teardown();
        assert_eq!(codex_bind::resume_seq(id), None);
    }

    /// Gap 18 review: two spawns of one id prepared at once can finish out of
    /// order. The older one may not replace the newer one's PTY, whose
    /// teardown is the only one that ends the newer spawn's grants.
    #[test]
    fn an_older_spawn_never_replaces_a_newer_ones_pty() {
        use crate::services::agent_fence;
        let id = "gen-reg:order";
        let mut reg = PtyRegistry::default();
        let older = agent_fence::begin_spawn(id);
        let newer = agent_fence::begin_spawn(id);
        // The newer spawn's prepare finished first.
        let (master, writer, child) = sleeper();
        let newer_pid = child.process_id();
        assert!(reg.insert_current_spawn(id.into(), master, writer, child, Arc::new(AtomicBool::new(false)), newer).is_ok());
        let (master, writer, child) = sleeper();
        let mut refused = reg
            .insert_current_spawn(id.into(), master, writer, child, Arc::new(AtomicBool::new(false)), older)
            .expect_err("the older spawn is refused");
        let _ = refused.kill();
        assert_eq!(reg.pid(id), newer_pid, "the newer spawn's PTY stays");
        assert_eq!(reg.entries.get(id).map(|e| e.seq), Some(newer));
        // So the newer spawn's own teardown is the one that ends the tab.
        reg.take(id).expect("the newer PTY").teardown();
        assert!(!agent_fence::is_current_spawn(id, newer), "its teardown was current");
    }

    /// Closing a tab must abort the process **inside** it, not just the shell
    /// leader: a `sh` whose child is a long-running `sleep` must leave no live
    /// `sleep` behind once the PTY is killed.
    #[test]
    fn kill_reaps_the_child_subtree() {
        // This test invalidates and repopulates the process-tree cache in its
        // poll loop below, which is exactly the global state sysstat's
        // cache-mechanics tests seed synthetic entries into. Share their lock so
        // the two never interleave.
        let _cache_guard = crate::sysstat::lock_cache_for_test();
        let pty_system = NativePtySystem::default();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");

        // The trailing `; true` defeats the shell's exec-optimization so `sleep`
        // is a genuine *child* of `sh` (the leader), not the leader itself.
        let mut cmd = CommandBuilder::new("sh");
        cmd.arg("-c");
        cmd.arg("sleep 300; true");
        let child = pair.slave.spawn_command(cmd).expect("spawn sh");
        let leader = child.process_id().expect("leader pid");
        let writer = pair.master.take_writer().expect("take writer");
        let master = pair.master;

        let registry = Arc::new(Mutex::new(PtyRegistry::default()));
        let dead = Arc::new(AtomicBool::new(false));
        registry
            .lock()
            .unwrap()
            .insert("test".to_string(), master, writer, child, dead, 0);

        // SAFETY: kill(pid, 0) probes existence without signalling; no pointers.
        let alive = |pid: u32| unsafe { libc::kill(pid as libc::pid_t, 0) == 0 };

        // Wait for the `sleep` child to appear as a descendant of the leader.
        let mut sleep_pid = None;
        for _ in 0..100 {
            crate::sysstat::invalidate_descendant_cache();
            if let Some(&pid) = crate::sysstat::descendant_pids(&[leader])
                .iter()
                .find(|&&p| p != leader)
            {
                sleep_pid = Some(pid);
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let sleep_pid = sleep_pid.expect("sleep child should have spawned");
        assert!(
            alive(sleep_pid),
            "sleep child should be running before kill"
        );

        registry.lock().unwrap().kill("test");

        // The graceful SIGTERM terminates `sleep` (default disposition); init
        // then reaps the reparented zombie. Poll until the pid is truly gone.
        let mut gone = false;
        for _ in 0..250 {
            if !alive(sleep_pid) {
                gone = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            gone,
            "the inner process must be aborted when the tab is closed"
        );
    }

    /// `take` + `teardown_taken`, the shape `pty_kill_scope` uses: the PTYs
    /// leave the registry at once (so the lock is free for every other tab's
    /// keystrokes), and one teardown afterwards still aborts every tab's inner
    /// process, not just the shell leaders.
    #[test]
    fn taken_ptys_leave_the_registry_and_one_teardown_reaps_every_subtree() {
        let _cache_guard = crate::sysstat::lock_cache_for_test();
        // SAFETY: kill(pid, 0) probes existence without signalling; no pointers.
        let alive = |pid: u32| unsafe { libc::kill(pid as libc::pid_t, 0) == 0 };
        let registry = Arc::new(Mutex::new(PtyRegistry::default()));
        let mut leaders = Vec::new();
        for id in ["scope:a", "scope:b"] {
            let pair = NativePtySystem::default()
                .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
                .expect("openpty");
            let mut cmd = CommandBuilder::new("sh");
            cmd.arg("-c");
            cmd.arg("sleep 300; true");
            let child = pair.slave.spawn_command(cmd).expect("spawn sh");
            leaders.push(child.process_id().expect("leader pid"));
            let writer = pair.master.take_writer().expect("take writer");
            registry.lock().unwrap().insert(
                id.to_string(),
                pair.master,
                writer,
                child,
                Arc::new(AtomicBool::new(false)),
                0,
            );
        }
        // Each leader's `sleep` child, once it has appeared.
        let mut inner = Vec::new();
        for &leader in &leaders {
            let mut found = None;
            for _ in 0..100 {
                crate::sysstat::invalidate_descendant_cache();
                if let Some(&pid) =
                    crate::sysstat::descendant_pids(&[leader]).iter().find(|&&p| p != leader)
                {
                    found = Some(pid);
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            inner.push(found.expect("sleep child should have spawned"));
        }

        let taken: Vec<TakenPty> = {
            let mut reg = registry.lock().unwrap();
            let ids = reg.ids_for_scope("scope");
            ids.iter().filter_map(|id| reg.take(id)).collect()
        };
        assert_eq!(taken.len(), 2);
        {
            let reg = registry.lock().unwrap();
            assert!(reg.input_sender("scope:a").is_none() && reg.input_sender("scope:b").is_none());
            assert!(!reg.any_live_for_scope("scope"));
        }
        assert!(taken.iter().all(|t| t.entry.dead.load(Ordering::SeqCst)));

        teardown_taken(taken);
        for pid in inner {
            let mut gone = false;
            for _ in 0..250 {
                if !alive(pid) {
                    gone = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            assert!(gone, "every taken tab's inner process must be aborted");
        }
    }
}

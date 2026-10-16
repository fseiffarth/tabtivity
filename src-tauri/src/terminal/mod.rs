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

use std::collections::{BTreeMap, HashMap, HashSet};
use app_core::sync::LockExt;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use portable_pty::{Child, CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::{Deserialize, Serialize};
use app_core::{Caller, ClientId, CoreCtx};

mod replay_trim;
use replay_trim::{trim_replay, ScreenState, REPLAY_TRIM_FLOOR};

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
// activity digests: the accumulated tail, batched across every hidden PTY
// into one `terminal-activity-batch` per `ACTIVITY_INTERVAL` window
// (`DigestClock`) — emitted leading-edge after quiet, then at the window's
// end, so the decision prompt that arrives right before quiet is still
// reported.
//
// Showing the pane again (`pty_set_visible`) drains `pending` as ONE
// `terminal-replay` event — cut at its last full clear with the terminal
// state the dropped frames set re-applied in front (`replay_trim`), so a
// long hidden spell replays a screen, not a megabyte of dead frames. It is
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

/// How often hidden PTYs' buffered output is condensed into one
/// `terminal-activity-batch` of digests. Must stay well under the activity store's
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

/// The catch-up tail of a PTY whose pane is ASLEEP (performance plan §5.3):
/// its `TerminalView` was unmounted after a long while hidden, so no xterm
/// holds its history any more and the wake repaints from this tail alone. A
/// sleeping shell keeps a few screens more than a popout's catch-up needs.
/// Applies from the sleeping `pty_remove_view` until the wake reads it back.
const ROUTE_SLEEP_SCROLLBACK_CAP: usize = 1_000_000;

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
    /// The terminal state set by bytes `ROUTE_PENDING_CAP` already trimmed off
    /// the front of `pending` (a mode switch there must still reach xterm when
    /// the pane is shown). Folded on each trim, spent by the replay.
    carried: ScreenState,
    /// A bounded tail of everything routed for this PTY (see
    /// `ROUTE_SCROLLBACK_CAP`), so a viewer attaching to an already-running
    /// terminal can catch up instead of opening blank.
    retained: String,
    /// The terminal state set by bytes the cap already trimmed off the front of
    /// `retained` — the modes a TUI switched on at its start (bracketed paste,
    /// the alternate screen, mouse reporting, cursor keys) are long gone from a
    /// tail of a session that has run for hours. A catch-up read puts it in
    /// front of the tail, so a fresh xterm (a woken pane, a popout) reads keys
    /// and pastes the way the program expects. Folded on each trim, never spent.
    retained_carried: ScreenState,
    /// Absolute UTF-8 byte offset of `retained[0]` in this spawn's output.
    retained_start: u64,
    /// The PTY's pane is asleep (§5.3): its view left with `sleeping`, so no
    /// xterm holds this terminal's history. The tail is kept to
    /// `ROUTE_SLEEP_SCROLLBACK_CAP`, and a spawn that ends meanwhile keeps its
    /// route (and tail) for the wake to show. Cleared by the wake's read
    /// (`route_wake_scrollback`), by `pty_kill` (`route_forget_sleep`), and by
    /// a respawn from a registered pane.
    asleep: bool,
    /// The windows whose view left with `sleeping` and has not come back. A
    /// server client's sleeping pane still owns its tab: its activity, exit
    /// and heir decisions go to it though it has no view (`event_windows`).
    /// A window that goes away ends its sleep (`route_drop_window_views`).
    sleepers: Vec<String>,
    /// The spawn this route carried has ended (its task closed the route while
    /// something still held it). A respawn clears it.
    ended: bool,
    /// Absolute UTF-8 byte offset of `pending[0]`.
    pending_start: u64,
    /// Absolute UTF-8 byte offset immediately after the latest routed chunk.
    output_offset: u64,
    /// Output since the last activity digest (tail-capped).
    digest: String,
    /// When a tick last drained `digest`; `None` = the next chunk is due at once.
    last_digest: Option<Instant>,
    /// UTF-8 decoder state shared by every output chunk for this spawn.
    decoder: Utf8StreamDecoder,
    /// Spawn generation, so a respawn under the same id survives the previous
    /// spawn's task-end cleanup.
    seq: u64,
    /// The tab id this route's events name, when it is not the route's own key:
    /// a server client's attach PTY (`<tab>@<client>`, see [`attach_pty_id`])
    /// streams under the tab's id, which is all the client's frontend knows.
    tab: Option<String>,
}

impl OutputRoute {
    fn subscribed(&self) -> bool {
        self.visible_viewers.values().any(|v| v.visible) || self.watchers > 0
    }

    /// When a hidden chunk arriving at `now` must be digested by: at once
    /// after a quiet window (or ever), else by the end of the window its last
    /// drain opened — the per-PTY cadence `DigestClock` keeps.
    fn digest_due_by(&self, now: Instant) -> Instant {
        self.last_digest
            .map_or(now, |last| (last + ACTIVITY_INTERVAL).max(now))
    }

    /// Every window other than the main one with a view of this PTY registered,
    /// shown or hidden (a hidden view still buffers what a sibling view streams).
    /// See `emit_output`.
    fn viewer_windows(&self) -> Vec<String> {
        let mut windows: Vec<String> = Vec::new();
        for v in self.visible_viewers.values() {
            if v.window != ClientId::MAIN && !windows.contains(&v.window) {
                windows.push(v.window.clone());
            }
        }
        windows
    }

    /// The windows a PTY's events (activity, exit) go to: those with a view,
    /// and those whose pane sleeps on it — a sleeping tab still shows its
    /// activity. Output itself goes to `viewer_windows` only.
    fn event_windows(&self) -> Vec<String> {
        let mut windows = self.viewer_windows();
        for w in &self.sleepers {
            if w.as_str() != ClientId::MAIN && !windows.contains(w) {
                windows.push(w.clone());
            }
        }
        windows
    }

    /// The sleepers whose window registered a view again are awake.
    fn drop_woken_sleepers(&mut self) {
        let viewers = &self.visible_viewers;
        self.sleepers.retain(|w| !viewers.values().any(|v| &v.window == w));
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
        let cap = if self.asleep { ROUTE_SLEEP_SCROLLBACK_CAP } else { ROUTE_SCROLLBACK_CAP };
        if let Some(cut) = hysteresis_cut(&self.retained, cap) {
            self.retained_carried.observe(&self.retained[..cut]);
            self.retained.drain(..cut);
            self.retained_start += cut as u64;
        }
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
        if let Some(cut) = hysteresis_cut(&self.pending, ROUTE_PENDING_CAP) {
            self.carried.observe(&self.pending[..cut]);
            self.pending.drain(..cut);
            self.pending_start += cut as u64;
        }
    }

    /// Drain the hidden-spell buffer for a replay emit. Also drops the digest:
    /// its bytes are a subset of `pending` and have just been delivered.
    ///
    /// The slice's offsets are the stream range the replay *covers*; its text
    /// is that range cut down to what xterm needs (`replay_trim`), so the two
    /// no longer agree byte for byte. The only reader of replay offsets drops
    /// a replay that ends inside its scrollback snapshot (`TerminalView`'s
    /// `outputAfterScrollback`), which a whole-range comparison still answers.
    fn take_pending(&mut self) -> Option<OutputSlice> {
        self.digest.clear();
        if self.pending.is_empty() {
            self.carried = ScreenState::default();
            return None;
        }
        let carried = std::mem::take(&mut self.carried);
        let text = trim_replay(std::mem::take(&mut self.pending), &carried, REPLAY_TRIM_FLOOR);
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

/// The one clock every hidden PTY's digests ride on (performance plan §7.6).
///
/// One `terminal-activity` event per hidden streaming PTY per window made
/// thirty working agents sixty events a second into the main renderer. Now a
/// tick drains EVERY hidden route's digest into one `terminal-activity-batch`.
/// Each route keeps the per-PTY cadence it had with its own timer: its chunk
/// after a quiet window is digested at once (leading edge), a chunk inside the
/// window by the window's end (trailing: the decision prompt right before
/// quiet still goes out) — `OutputRoute::digest_due_by`. The clock holds the
/// earliest such deadline over every hidden route: a chunk whose own deadline
/// is earlier than the armed tick pulls the tick forward (the later task wakes
/// superseded and does nothing), so no PTY's digests are ever further apart
/// than `max(ACTIVITY_INTERVAL, its chunk gap)` — the gap `BUSY_WINDOW_MS`
/// relies on. Routes streaming through the same windows share one tick, and
/// while no hidden PTY streams nothing is armed.
///
/// Lock order: this clock is taken BEFORE the routes lock, always.
#[derive(Debug, Default)]
struct DigestClock {
    /// The deadline the armed tick task sleeps toward, if one is armed.
    deadline: Option<Instant>,
    /// The armed tick's generation: a superseded task wakes to a newer one.
    generation: u64,
}

impl DigestClock {
    /// A hidden route wants its digest out by `by`: the tick to arm for it,
    /// unless the armed tick already fires by then.
    fn arm(&mut self, by: Instant) -> Option<DigestTick> {
        if self.deadline.is_some_and(|d| d <= by) {
            return None;
        }
        self.generation += 1;
        self.deadline = Some(by);
        Some(DigestTick {
            deadline: by,
            generation: self.generation,
        })
    }

    /// A tick task woke: whether it is the armed one (then it drains), or
    /// one a later, earlier arm superseded (then the newer task drains).
    fn tick(&mut self, generation: u64) -> bool {
        if self.generation != generation {
            return false;
        }
        self.deadline = None;
        true
    }
}

/// An armed digest tick, for the task that sleeps toward it.
#[derive(Clone, Copy, Debug, PartialEq)]
struct DigestTick {
    deadline: Instant,
    generation: u64,
}

fn digest_clock() -> &'static Mutex<DigestClock> {
    static CLOCK: OnceLock<Mutex<DigestClock>> = OnceLock::new();
    CLOCK.get_or_init(|| Mutex::new(DigestClock::default()))
}


/// Trim with hysteresis (the frontend buffer's rule): cutting exactly to the
/// cap on every chunk past it re-copies the whole buffer per chunk; letting it
/// grow to 2× and cutting back costs one copy per cap's worth of new output.
/// The buffer already contains decoded text, so advance the cut to a character
/// boundary rather than creating replacement characters during replay.
fn trim_with_hysteresis(buf: &mut String, cap: usize) -> usize {
    match hysteresis_cut(buf, cap) {
        Some(cut) => {
            buf.drain(..cut);
            cut
        }
        None => 0,
    }
}

/// Where `trim_with_hysteresis` would cut, for a caller that reads the cut-off
/// front before dropping it.
fn hysteresis_cut(buf: &str, cap: usize) -> Option<usize> {
    if buf.len() > cap * 2 {
        let mut cut = buf.len() - cap;
        while cut < buf.len() && !buf.is_char_boundary(cut) {
            cut += 1;
        }
        return Some(cut);
    }
    None
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
    /// Hidden, and no digest tick fires soon enough for this route: spawn one
    /// for this deadline (`arm_digest_tick`).
    ArmDigest(DigestTick),
    /// Hidden, a digest tick is already armed in time: nothing to do.
    Quiet,
}

fn route_chunk_at(id: &str, bytes: &[u8], now: Instant, seq: u64) -> Routed {
    let mut clock = digest_clock().lock_ok();
    let mut map = routes().lock_ok();
    route_chunk_in(&mut map, &mut clock, id, bytes, now, seq)
}

/// `route_chunk_at` against a given route map and digest clock (the tests'
/// own, so a tick armed by another test's route can't make a chunk read as
/// quiet, and a test's drain never takes a sibling's digest).
fn route_chunk_in(
    map: &mut HashMap<String, OutputRoute>,
    clock: &mut DigestClock,
    id: &str,
    bytes: &[u8],
    now: Instant,
    seq: u64,
) -> Routed {
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
    match clock.arm(route.digest_due_by(now)) {
        Some(tick) => Routed::ArmDigest(tick),
        None => Routed::Quiet,
    }
}

fn route_chunk(id: &str, bytes: &[u8], seq: u64) -> Routed {
    route_chunk_at(id, bytes, Instant::now(), seq)
}

/// Flush an incomplete UTF-8 suffix when the PTY reaches EOF. Complete streams
/// produce no extra event; a genuinely truncated codepoint produces one
/// replacement character and follows the current visible/hidden route.
fn route_finish(id: &str, seq: u64) -> Routed {
    let mut clock = digest_clock().lock_ok();
    let mut map = routes().lock_ok();
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
    let now = Instant::now();
    match clock.arm(route.digest_due_by(now)) {
        Some(tick) => Routed::ArmDigest(tick),
        None => Routed::Quiet,
    }
}

/// The digest tick of `generation`: drain every hidden route's digest for one
/// `terminal-activity-batch`, in id order, stamping each route's drain so its
/// next chunk knows its window. Empty when nothing is due (no event) — and
/// when a later, earlier arm superseded this tick (that one drains).
fn digest_batch_take_in(
    map: &mut HashMap<String, OutputRoute>,
    now: Instant,
    clock: &mut DigestClock,
    generation: u64,
) -> Vec<(String, String)> {
    if !clock.tick(generation) {
        return Vec::new();
    }
    let mut batch: Vec<(String, String)> = map
        .iter_mut()
        .filter(|(_, route)| !route.subscribed() && !route.digest.is_empty())
        .map(|(id, route)| {
            route.last_digest = Some(now);
            (id.clone(), std::mem::take(&mut route.digest))
        })
        .collect();
    batch.sort_by(|a, b| a.0.cmp(&b.0));
    batch
}

fn route_digest_batch_take(generation: u64) -> Vec<(String, String)> {
    let mut clock = digest_clock().lock_ok();
    let mut map = routes().lock_ok();
    digest_batch_take_in(&mut map, Instant::now(), &mut clock, generation)
}

/// Sleep toward a digest tick's deadline, then emit what every hidden PTY
/// accumulated as one `terminal-activity-batch`. A short-lived task, alive
/// only while some hidden PTY is mid-burst: an idle or visible PTY arms
/// nothing, keeping the zero-idle-wakeups discipline of `batch_output`.
///
/// Each entry names the tab its events go under (an attach PTY's route names
/// its tab, [`attach_pty_id`]). On the desktop the batch is one broadcast; a
/// server host's client (`per_client`) gets only the entries of the PTYs it
/// has a view of, as [`emit_pty_event`] addresses a single PTY's events.
fn arm_digest_tick(ctx: &CoreCtx, tick: DigestTick) {
    let ctx = ctx.clone();
    tokio::spawn(async move {
        tokio::time::sleep_until(tokio::time::Instant::from_std(tick.deadline)).await;
        let batch = route_digest_batch_take(tick.generation);
        if batch.is_empty() {
            return;
        }
        let addressed = address_digest_batch(&routes().lock_ok(), batch);
        emit_activity_batch(&ctx, addressed);
    });
}

/// Each drained digest as its event entry — under the tab an attach route
/// names, else its own id — with the windows that view its route or sleep on
/// it (`event_windows`).
fn address_digest_batch(map: &HashMap<String, OutputRoute>, batch: Vec<(String, String)>) -> Vec<(TerminalOutput, Vec<String>)> {
    batch
        .into_iter()
        .map(|(id, data)| {
            let route = map.get(&id);
            let windows = route.map(OutputRoute::event_windows).unwrap_or_default();
            let id = route.and_then(|r| r.tab.clone()).unwrap_or(id);
            (TerminalOutput { id, data, start_offset: None, end_offset: None }, windows)
        })
        .collect()
}

/// One `terminal-activity-batch`: a broadcast on the desktop; for a server
/// host's client, each viewing client gets its own entries only.
fn emit_activity_batch(ctx: &CoreCtx, addressed: Vec<(TerminalOutput, Vec<String>)>) {
    if !per_client(ctx) {
        let payload: Vec<TerminalOutput> = addressed.into_iter().map(|(entry, _)| entry).collect();
        ctx.emit("terminal-activity-batch", payload);
        return;
    }
    let mut per_window: BTreeMap<String, Vec<TerminalOutput>> = BTreeMap::new();
    for (entry, windows) in addressed {
        for window in windows {
            per_window.entry(window).or_default().push(TerminalOutput {
                id: entry.id.clone(),
                data: entry.data.clone(),
                start_offset: None,
                end_offset: None,
            });
        }
    }
    for (window, payload) in per_window {
        emit_to_windows(ctx, &[window], "terminal-activity-batch", &payload);
    }
}

/// A route under a fresh generation, for the tests.
#[cfg(test)]
fn route_open(id: &str) -> u64 {
    let seq = crate::services::agent_fence::next_spawn_seq();
    route_open_at(id, None, seq);
    seq
}

/// Register a (re)spawn: keep the pane's visibility and any watchers, drop
/// stale buffers, and record the generation the task-end cleanup is guarded
/// by — the spawn's own sequence number (`PreparedLaunch::spawn_seq`), so the
/// task end names the spawn it belonged to. `tab` is set for a route whose
/// events name that tab instead of `id` (an attach PTY's, see
/// [`attach_pty_id`]).
fn route_open_at(id: &str, tab: Option<&str>, seq: u64) {
    let mut map = routes().lock_ok();
    let route = map.entry(id.to_string()).or_default();
    route.tab = tab.map(str::to_string);
    route.pending.clear();
    // The state the cap trimmed off the predecessor's buffer is its, not the
    // new program's: replaying it would put xterm on the old program's screen.
    route.carried = ScreenState::default();
    route.digest.clear();
    route.last_digest = None;
    // A respawn is a new program: its predecessor's screen is not this one's
    // catch-up. (Same reason the pending buffer is cleared.)
    route.retained.clear();
    route.retained_carried = ScreenState::default();
    route.retained_start = 0;
    route.pending_start = 0;
    route.output_offset = 0;
    route.decoder = Utf8StreamDecoder::default();
    route.seq = seq;
    route.ended = false;
    // A pane that registered and is spawning anew is awake. A spawn with no
    // view (a backend-side restart under a sleeping pane) keeps the flag: the
    // pane is still asleep and its wake still needs the long tail.
    if !route.visible_viewers.is_empty() {
        route.asleep = false;
        route.drop_woken_sleepers();
    }
}

/// The retained catch-up tail for `id` (Group B #235), or an empty string when
/// nothing is known about that PTY. Read-only: a replay does NOT consume it, so
/// a second window attaching later gets the same history.
pub fn route_scrollback(id: &str) -> TerminalScrollback {
    let map = routes().lock_ok();
    match map.get(id) {
        Some(route) => TerminalScrollback {
            // Whole (no cut: `usize::MAX`), behind the state its trimmed-off
            // front left, if any.
            data: trim_replay(route.retained.clone(), &route.retained_carried, usize::MAX),
            start_offset: route.retained_start,
            end_offset: route.output_offset,
            exited: route.ended,
        },
        None => TerminalScrollback::default(),
    }
}

/// The catch-up for a pane WAKING from sleep (§5.3): the retained tail, cut at
/// its last full clear like a hidden spell's replay (`trim_replay`, nothing
/// below `REPLAY_TRIM_FLOOR` is cut), so up to a megabyte of a TUI's redraws
/// does not reach the new xterm as one parse. Ends the route's sleep: the pane
/// registered its view before asking, so the tail returns to the ordinary cap
/// as output continues. `exited` says the program ended while asleep — the
/// pane has no `terminal-exit` listener then, so the wake says it.
pub fn route_wake_scrollback(id: &str) -> TerminalScrollback {
    let mut map = routes().lock_ok();
    let Some(route) = map.get_mut(id) else {
        return TerminalScrollback::default();
    };
    route.asleep = false;
    route.drop_woken_sleepers();
    // The tail covers everything the hidden-spell buffer holds. A pane woken
    // while still hidden (a relaunch, the setting turned off) would otherwise
    // get that buffer again as a replay on its first show — the same output
    // twice. Dropped only when the waking view is the only one: another view
    // still hidden is owed its replay.
    if route.visible_viewers.len() <= 1 {
        route.pending.clear();
        route.carried = ScreenState::default();
        route.pending_start = route.output_offset;
    }
    let data = trim_replay(route.retained.clone(), &route.retained_carried, REPLAY_TRIM_FLOOR);
    let snapshot = TerminalScrollback {
        data,
        start_offset: route.retained_start,
        end_offset: route.output_offset,
        exited: route.ended,
    };
    if route.seq == 0 && route.visible_viewers.is_empty() && route.watchers == 0 {
        map.remove(id);
    }
    snapshot
}

/// A sleeping pane's tab was closed (`pty_kill`): the route no longer waits
/// for a wake. A route whose spawn already ended is dropped now (nothing else
/// would); a live one closes with its spawn, as any other.
pub fn route_forget_sleep(id: &str) {
    let mut map = routes().lock_ok();
    let Some(route) = map.get_mut(id) else { return };
    route.asleep = false;
    route.sleepers.clear();
    if route.seq == 0 && route.visible_viewers.is_empty() && route.watchers == 0 {
        map.remove(id);
    }
}

/// Whether spawn `seq` of `id` still runs: its route is open and its reader
/// has not closed it yet ([`route_close`] zeroes or drops the route first).
pub fn route_spawn_live(id: &str, seq: u64) -> bool {
    routes().lock_ok().get(id).is_some_and(|r| r.seq == seq)
}

/// Task-end cleanup, guarded by generation so an old spawn's exit can never
/// remove the route a respawn under the same id just opened. Returns whether
/// this was the current spawn, which makes the lifecycle notification obey the
/// same guard as the route cleanup.
fn route_close(id: &str, seq: u64) -> bool {
    let mut map = routes().lock_ok();
    if !map.get(id).is_some_and(|r| r.seq == seq) {
        return false;
    }
    // A sleeping pane's route outlives its spawn: the wake shows what the
    // program printed and that it ended (`route_wake_scrollback`).
    let remove = map
        .get(id)
        .is_some_and(|r| r.visible_viewers.is_empty() && r.watchers == 0 && !r.asleep);
    if remove {
        map.remove(id);
    } else if let Some(route) = map.get_mut(id) {
        route.seq = 0;
        route.ended = true;
        route.decoder = Utf8StreamDecoder::default();
    }
    true
}

/// Emit a rising edge's replay while STILL holding the routes lock: every live
/// chunk emit also takes this lock first (`route_chunk`), so the replay is
/// guaranteed to precede any output produced after the flip.
fn emit_replay(ctx: &CoreCtx, id: &str, route: &mut OutputRoute) {
    if let Some(slice) = route.take_pending() {
        let tab = route.tab.clone();
        emit_output(ctx, "terminal-replay", tab.as_deref().unwrap_or(id), slice);
    }
}

/// Whether `ctx` speaks for a server host's client (a browser page, hosted
/// plan §3.5): its PTY events go to the clients viewing that PTY, one frame
/// each. The desktop's callers are `Local` windows and keep the broadcast
/// below; a server never names a client `main`.
fn per_client(ctx: &CoreCtx) -> bool {
    matches!(ctx.caller, Caller::Client(_))
}

/// Emit a chunk of a PTY's output (`terminal-output`) or a replay
/// (`terminal-replay`). Tauri evaluates every emit in every webview that
/// listens for that event name, whatever the listener's target, so one shared
/// name made each popout parse every chunk of every PTY the main window
/// streams. The main window keeps the plain name: it receives every chunk, as
/// its activity classifier needs. A popout listens on `<event>:<its label>`
/// (`terminalBus.ts`) and gets only the PTYs it has a view of. (Both are
/// broadcasts by name, the desktop's way of addressing a window.)
///
/// A server host's client (`per_client`) is addressed instead: the chunk,
/// serialized once, goes under the plain name to each client with a view of
/// the PTY and to nobody else (TODO #2345) — no `:<label>` copies, which a
/// browser page never subscribes to.
fn emit_output(ctx: &CoreCtx, event: &str, id: &str, slice: OutputSlice) {
    let payload = TerminalOutput {
        id: id.to_string(),
        data: slice.text,
        start_offset: Some(slice.start_offset),
        end_offset: Some(slice.end_offset),
    };
    if per_client(ctx) {
        emit_to_windows(ctx, &slice.windows, event, &payload);
        return;
    }
    for window in &slice.windows {
        ctx.emit(&format!("{event}:{window}"), &payload);
    }
    ctx.emit(event, payload);
}

/// Serialize `payload` once and deliver it to each of `windows`.
fn emit_to_windows<S: Serialize>(ctx: &CoreCtx, windows: &[String], event: &str, payload: &S) {
    if windows.is_empty() {
        return;
    }
    match serde_json::to_string(payload) {
        Ok(json) => {
            for window in windows {
                ctx.events.emit_json_to(&ClientId::new(window.as_str()), event, json.clone());
            }
        }
        Err(e) => eprintln!("terminal: serialize {event}: {e}"),
    }
}

/// A PTY's lifecycle or activity event (`terminal-ready`, `terminal-exit`,
/// `terminal-activity`): a broadcast on the desktop, as ever; for a server
/// host's client, delivered to the clients with a view of `route`, or a pane
/// asleep on it, only (`event_windows`).
fn emit_pty_event<S: Serialize>(ctx: &CoreCtx, route: &str, event: &str, payload: S) {
    if !per_client(ctx) {
        ctx.emit(event, payload);
        return;
    }
    let windows = routes()
        .lock_ok()
        .get(route)
        .map(OutputRoute::event_windows)
        .unwrap_or_default();
    emit_to_windows(ctx, &windows, event, &payload);
}

/// One TerminalView instance's visibility report (`pty_set_visible`). `window`
/// is the label of the Tauri window the view lives in, taken from the CALLING
/// window rather than from the payload, so a view can only ever speak for
/// itself — and so `route_drop_window_views` can clean up after a window that
/// died without unmounting.
pub fn route_set_visible(
    ctx: &CoreCtx,
    id: &str,
    viewer_id: &str,
    visible: bool,
    update_seq: u64,
    window: &str,
) {
    let mut map = routes().lock_ok();
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
        emit_replay(ctx, id, route);
    }
}

/// Remove a TerminalView instance without changing any sibling view's state.
///
/// `sleeping`: the view leaves because its pane is going to sleep (§5.3), not
/// because its tab closed. The PTY keeps running with no xterm behind it, so
/// the route keeps the longer catch-up tail and outlives the spawn's end until
/// the wake reads it (or the tab's `pty_kill` forgets it).
pub fn route_remove_view(id: &str, viewer_id: &str, update_seq: u64, sleeping: bool) {
    let mut map = routes().lock_ok();
    let Some(route) = map.get_mut(id) else { return };
    if route
        .visible_viewers
        .get(viewer_id)
        .is_some_and(|v| v.seq > update_seq)
    {
        return;
    }
    let left = route.visible_viewers.remove(viewer_id);
    if sleeping {
        route.asleep = true;
        if let Some(window) = left.map(|v| v.window) {
            if !route.sleepers.contains(&window) {
                route.sleepers.push(window);
            }
        }
        return;
    }
    if route.seq == 0 && route.visible_viewers.is_empty() && route.watchers == 0 && !route.asleep {
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
    let mut map = routes().lock_ok();
    let mut dropped = 0usize;
    let mut empty: Vec<String> = Vec::new();
    for (id, route) in map.iter_mut() {
        let before = route.visible_viewers.len();
        route.visible_viewers.retain(|_, v| v.window != window);
        dropped += before - route.visible_viewers.len();
        // A window that slept the pane is gone: no wake will come from it.
        let sleepers = route.sleepers.len();
        route.sleepers.retain(|w| w != window);
        if sleepers > 0 && route.sleepers.is_empty() {
            route.asleep = false;
        }
        // Same collection rule `route_remove_view` applies: a route whose spawn
        // has already ended and that nothing watches any more is dead weight —
        // unless a sleeping main pane still has its wake to show.
        if route.seq == 0 && route.visible_viewers.is_empty() && route.watchers == 0 && !route.asleep {
            empty.push(id.clone());
        }
    }
    for id in empty {
        map.remove(&id);
    }
    dropped
}

/// Move `window`'s view registrations from route `from` to route `to`, keeping
/// every other window's where they are.
///
/// A server client's pane registers its view (`pty_set_visible`) *before* it
/// spawns, under the id it resolves to at that moment — the tab's own route
/// when the client has no attach PTY yet. `pty_spawn` then decides between the
/// tab PTY and an attach PTY of its own (`join_tab`), and the registrations
/// follow the decision, so the client's output comes from exactly one stream.
pub fn route_move_window_views(from: &str, to: &str, window: &str) {
    if from == to {
        return;
    }
    let mut map = routes().lock_ok();
    let Some(route) = map.get_mut(from) else { return };
    let moved: Vec<(String, ViewerReg)> = route
        .visible_viewers
        .iter()
        .filter(|(_, v)| v.window == window)
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    if moved.is_empty() {
        return;
    }
    for (viewer, _) in &moved {
        route.visible_viewers.remove(viewer);
    }
    if route.seq == 0 && route.visible_viewers.is_empty() && route.watchers == 0 {
        map.remove(from);
    }
    let target = map.entry(to.to_string()).or_default();
    target.visible_viewers.extend(moved);
}

/// The windows (server clients) with a view of route `id`, shown or hidden,
/// or a pane asleep on it.
fn route_viewer_windows(id: &str) -> Vec<String> {
    routes()
        .lock_ok()
        .get(id)
        .map(OutputRoute::event_windows)
        .unwrap_or_default()
}

/// Scope teardown owns the PTY, so no view registration may keep its route
/// alive after the process tree is reaped.
pub fn route_remove_all_views(id: &str) {
    routes().lock_ok().remove(id);
}

/// A marker-watcher's hold (`pty_watch`): stream this PTY as if visible.
pub fn route_watch(ctx: &CoreCtx, id: &str) {
    let mut map = routes().lock_ok();
    let route = map.entry(id.to_string()).or_default();
    let was = route.subscribed();
    route.watchers += 1;
    if !was {
        emit_replay(ctx, id, route);
    }
}

/// Release a watch. Unbalanced releases are harmless (saturating), and a
/// watch leaked by a webview reload merely leaves the PTY streaming — today's
/// behaviour, the fail-open direction.
pub fn route_unwatch(id: &str) {
    let mut map = routes().lock_ok();
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
    /// A **login PTY** (`commands::credentials`): the backend runs the ssh /
    /// OpenVPN login for this target as the PTY's own program, ignoring `cmd`,
    /// `args`, `env` and `cwd`, and only such a PTY may receive a saved secret
    /// (`credential_paste_to_pty`). Refused together with anything that would
    /// make it more than a plain local root PTY.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub login: Option<crate::commands::credentials::LoginTarget>,
    /// A **chat assistant** tab (`services::assistant`, scope
    /// `storage::ASSISTANT_SCOPE`): the backend ignores `cmd`, `args` and `env`
    /// and builds the whole launch from this `{ cli, model }`
    /// (`assistant::launch_line`). Honoured only with `project_id ==
    /// Some("assistant")`, and required there; any other combination is
    /// refused at spawn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assistant: Option<crate::services::assistant::AssistantLaunch>,
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
    /// The spawn has ended (see `OutputRoute::ended`).
    pub exited: bool,
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
    meta: PtyMeta,
    /// The local folder the process works in (`PreparedLaunch::drop_dir`),
    /// where a file dropped onto the tab lands; `None` for a remote tab.
    drop_dir: Option<String>,
    /// The spawn's sequence number (`PreparedLaunch::spawn_seq`): what its
    /// teardown passes to `launch_prep::on_tab_gone`, so a kill that lands
    /// after a respawn of the same id cannot clear the respawn's state.
    seq: u64,
}

/// Who a PTY belongs to, beyond its id — empty for every desktop PTY.
///
/// A server host serves several clients (browser pages) from one registry,
/// and each wants its own size on a shared tab (hosted plan §3.5, TODO
/// #2347). A tab whose program lives in a local tmux session can give each
/// one: the tab's own PTY (id = tab id, carrying the tab's spawn bookkeeping)
/// is one tmux client, and every *other* client gets an attach PTY of its own
/// (`<tab>@<client>`, [`attach_pty_id`]) — another tmux client of the same
/// session, sized by that client alone.
#[derive(Clone, Debug, Default)]
pub struct PtyMeta {
    /// The server client that spawned it (`Caller::Client`), or the one it
    /// was handed to; `None` on the desktop, and on a server for a tab PTY
    /// of a local tmux session whose last client left. A client gone for
    /// good takes its PTYs with it unless somebody still needs them
    /// ([`PtyRegistry::release_client`]).
    pub client: Option<ClientId>,
    /// The local tmux session this PTY is a client of, when its spawn was
    /// wrapped in one (`tmux_local::wrap_pty_options_local`) — what another
    /// client attaches to.
    pub local_tmux: Option<String>,
    /// Set on an attach PTY: the tab it shows. Such a PTY carries none of the
    /// tab's bookkeeping (agent fence, MCP tokens, Codex binding): it is a
    /// viewer, and its end is only its client's.
    pub attach_of: Option<String>,
}

/// The registry id of `client`'s attach PTY onto `tab` (see [`PtyMeta`]).
/// Starts with the tab id, so a scope match (`pty_id_in_scope`) covers it.
pub fn attach_pty_id(tab: &str, client: &ClientId) -> String {
    format!("{tab}@{client}")
}

/// The server client behind `ctx`, if it is one.
fn server_client(ctx: &CoreCtx) -> Option<&ClientId> {
    match &ctx.caller {
        Caller::Client(client) => Some(client),
        _ => None,
    }
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
        self.insert_with(id, master, writer, child, dead, PtyMeta::default(), seq);
    }

    /// [`Self::insert`] with the PTY's [`PtyMeta`].
    #[allow(clippy::too_many_arguments)]
    pub fn insert_with(
        &mut self,
        id: String,
        master: Box<dyn MasterPty + Send>,
        writer: Box<dyn Write + Send>,
        child: Box<dyn Child + Send + Sync>,
        dead: Arc<AtomicBool>,
        meta: PtyMeta,
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
                meta,
                drop_dir: None,
                seq,
            },
        );
        // A new child (and the old one it may have replaced) changes the process
        // tree, so drop the cached descendant-pid set.
        invalidate_proc_tree_cache();
    }

    /// [`Self::insert_with`] for spawn `seq`, only while it is still the id's
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
        meta: PtyMeta,
        seq: u64,
    ) -> Result<(), Box<dyn Child + Send + Sync>> {
        if !crate::services::agent_fence::is_current_spawn(&id, seq) {
            return Err(child);
        }
        self.insert_with(id, master, writer, child, dead, meta, seq);
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

    /// [`Self::input_sender`], only while `id` still runs spawn `seq`: a respawn of
    /// the id is another program, whatever the spawn before it was.
    pub fn input_sender_of_spawn(
        &self,
        id: &str,
        seq: u64,
    ) -> Option<tokio::sync::mpsc::Sender<Vec<u8>>> {
        self.entries.get(id).filter(|e| e.seq == seq).map(|e| e.input_tx.clone())
    }

    /// The registry id `caller` means by `id`: its own attach PTY onto that
    /// tab when it has one — or would get one, the tab being another client's
    /// tmux tab ([`Self::attachable`]): a pane registers its view before it
    /// spawns, and that view belongs on the stream it is about to get, never
    /// on the other client's. Else `id` itself. Only a server client can have
    /// one, so on the desktop this is always `id`.
    pub fn resolve(&mut self, caller: &Caller, id: &str) -> String {
        if let Caller::Client(client) = caller {
            let attach = attach_pty_id(id, client);
            // Another client's attach PTY, named by its id (`<tab>@web-n` is
            // guessable): never this client's to write to, resize or kill —
            // it resolves to an id that names nothing.
            if self.is_foreign_attach(id, client) {
                return attach;
            }
            if self.entries.contains_key(&attach) || self.attachable(id, client).is_some() {
                return attach;
            }
        }
        id.to_string()
    }

    /// Whether `id` is an attach PTY that is not `client`'s own.
    fn is_foreign_attach(&self, id: &str, client: &ClientId) -> bool {
        self.entries
            .get(id)
            .is_some_and(|e| e.meta.attach_of.is_some() && e.meta.client.as_ref() != Some(client))
    }

    /// The local tmux session `client` may attach to for `tab`: the tab's own
    /// PTY is alive, a client of a local tmux session, and was spawned by a
    /// *different* server client — or by one gone for good, which left it to
    /// nobody ([`Self::release_client`]). `None` means the ordinary spawn: no
    /// tab PTY (or a dead one) — `new-session -A` re-attaches whatever
    /// survived — the client respawning its own, or a tab no tmux holds (a
    /// remote, container or Windows tab keeps the one shared PTY it always
    /// had).
    pub fn attachable(&mut self, tab: &str, client: &ClientId) -> Option<String> {
        let entry = self.entries.get_mut(tab)?;
        let session = entry.meta.local_tmux.clone()?;
        if entry.meta.client.as_ref() == Some(client) {
            return None;
        }
        let alive = !entry.dead.load(Ordering::SeqCst) && matches!(entry.child.try_wait(), Ok(None));
        alive.then_some(session)
    }

    /// `client` is gone for good: take every PTY it spawned, for the caller to
    /// tear down — except a tab PTY somebody else still needs:
    ///
    /// - another client is attached to it: handed to that client (it now ends
    ///   with that client) and sized like that client's own attach;
    /// - another client views it directly (a tab no local tmux holds — remote,
    ///   container, Windows — whose one PTY every page shares): handed to that
    ///   client, so its terminal is not killed under it;
    /// - nobody, but it is a client of a local tmux session, which lives on
    ///   without it: left to nobody (`client: None`) rather than ended, so the
    ///   tab's spawn bookkeeping — its agent's MCP grants, fence registration,
    ///   Codex binding — lives exactly as long as the session does, as a
    ///   headless spawn's does. Its tmux client ends with the session (and
    ///   the sweep below takes it then), at a clean stop (`kill_all`), or when
    ///   a page closes the tab; the next page to open the tab attaches to it.
    ///
    /// Also takes every such left-over PTY whose session has ended meanwhile:
    /// nothing else would ever take it.
    pub fn release_client(&mut self, client: &ClientId) -> Vec<TakenPty> {
        let ended: Vec<String> = self
            .entries
            .iter_mut()
            .filter(|(_, e)| e.meta.client.is_none() && e.meta.attach_of.is_none() && e.meta.local_tmux.is_some())
            .filter_map(|(id, e)| matches!(e.child.try_wait(), Ok(Some(_))).then(|| id.clone()))
            .collect();
        let mut taken: Vec<TakenPty> = ended.iter().filter_map(|id| self.take(id)).collect();
        let owned: Vec<String> = self
            .entries
            .iter()
            .filter(|(_, e)| e.meta.client.as_ref() == Some(client))
            .map(|(id, _)| id.clone())
            .collect();
        for id in owned {
            let heir = self
                .entries
                .values()
                .filter(|e| e.meta.attach_of.as_deref() == Some(id.as_str()))
                .filter(|e| !e.dead.load(Ordering::SeqCst))
                .find_map(|e| {
                    let heir = e.meta.client.clone().filter(|c| c != client)?;
                    Some((heir, e.master.get_size().ok()))
                });
            let is_tab = self.entries.get(&id).is_some_and(|e| e.meta.attach_of.is_none());
            if let (true, Some((heir, size))) = (is_tab, heir) {
                if let Some(entry) = self.entries.get_mut(&id) {
                    entry.meta.client = Some(heir);
                    // A resize is tmux activity: under `window-size latest`
                    // the session then follows the heir's size, not the size
                    // of a client nobody is looking at any more.
                    if let Some(size) = size {
                        let _ = entry.master.resize(size);
                    }
                }
                continue;
            }
            if is_tab {
                let viewer = route_viewer_windows(&id)
                    .into_iter()
                    .find(|w| w.as_str() != client.as_str());
                if let Some(viewer) = viewer {
                    if let Some(entry) = self.entries.get_mut(&id) {
                        entry.meta.client = Some(ClientId::new(viewer));
                    }
                    continue;
                }
                if let Some(entry) = self.entries.get_mut(&id).filter(|e| e.meta.local_tmux.is_some()) {
                    entry.meta.client = None;
                    continue;
                }
            }
            if let Some(pty) = self.take(&id) {
                taken.push(pty);
            }
        }
        taken
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
            // An attach PTY is a viewer: the tab's own cleanups are not its.
            if e.meta.attach_of.is_some() {
                continue;
            }
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
    /// The registry id it was taken under.
    pub fn id(&self) -> &str {
        &self.id
    }

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
        // An attach PTY (a server client's own tmux client onto a tab) is a
        // viewer: the tab's cleanups below belong to the tab's own PTY.
        if entry.meta.attach_of.is_some() {
            continue;
        }
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

/// Spawn a PTY and wire up its event emission (`ctx.events`).
/// The read loop runs in a std::thread (blocking I/O) and passes chunks
/// through an mpsc channel to a Tokio task that batches and emits events.
pub fn spawn_pty(
    ctx: CoreCtx,
    registry: Arc<Mutex<PtyRegistry>>,
    opts: PtyOptions,
    seq: u64,
) -> Result<(), String> {
    // Record this PTY id so a later remount (HMR, webview reload) is a known
    // re-spawn. Agent-session resolution (Claude/Codex resume args) happens in
    // the caller (`commands::terminal::pty_spawn`) *before* any ssh wrapping, so
    // remote agent tabs resume correctly; by the time the command reaches here it
    // is fully resolved (and possibly already rewritten to `ssh`).
    registry.lock_ok().seen.insert(opts.id.clone());

    // A server client's PTY is recorded as its (`release_client`), and one
    // that is a local tmux client can be attached to by another client
    // (`join_tab`). The wrap leaves `cmd` = `tmux` and the session name in
    // `tmux_session`; nothing else spawns a bare `tmux` with one.
    let meta = PtyMeta {
        client: server_client(&ctx).cloned(),
        local_tmux: opts.tmux_session.clone().filter(|_| opts.cmd == "tmux"),
        attach_of: None,
    };
    let cmd = build_command(&opts);
    launch(ctx, registry, &opts.id, cmd, opts.cols, opts.rows, meta, Some(&opts), seq)
}

/// Give `ctx`'s server client a PTY of its own onto `opts.id`'s tab when the
/// tab's program lives in a local tmux session another client's PTY holds
/// (TODO #2347): one more tmux client of that session, registered as
/// [`attach_pty_id`], sized and routed for this client alone. `attach_argv`
/// builds the `tmux` argv that attaches a session by name
/// (`tmux_local::attach_argv`; a test points it at its own server).
///
/// Also settles what the client held before: a previous attach PTY of its own
/// is taken (handed back for the caller to tear down off the async workers),
/// and the client's view registrations move to whichever PTY now serves it.
/// Anyone but a server client — every desktop window — gets the ordinary
/// spawn, untouched.
pub fn join_tab(
    ctx: &CoreCtx,
    registry: &Arc<Mutex<PtyRegistry>>,
    opts: &PtyOptions,
    attach_argv: impl Fn(&str) -> Vec<String>,
) -> Result<TabJoin, String> {
    let Some(client) = server_client(ctx).cloned() else {
        return Ok(TabJoin::default());
    };
    let attach_id = attach_pty_id(&opts.id, &client);
    let (stale, session) = {
        let mut reg = registry.lock_ok();
        // An attach PTY is a client's view of a tab, never a tab of its own:
        // a spawn under one's id would replace (kill) it. And the id this
        // client's attach would take must not be somebody else's PTY.
        if reg.entries.get(&opts.id).is_some_and(|e| e.meta.attach_of.is_some())
            || reg.entries.get(&attach_id).is_some_and(|e| e.meta.client.as_ref() != Some(&client))
        {
            return Err(format!("terminal: '{}' is not a tab this client may open", opts.id));
        }
        (reg.take(&attach_id), reg.attachable(&opts.id, &client))
    };
    let Some(session) = session else {
        // The ordinary spawn serves this client: its views belong on the tab.
        route_move_window_views(&attach_id, &opts.id, client.as_str());
        return Ok(TabJoin { attached: false, stale });
    };
    route_move_window_views(&opts.id, &attach_id, client.as_str());
    let attach = PtyOptions {
        login: None,
        assistant: None,
        id: attach_id.clone(),
        cmd: "tmux".to_string(),
        local_model: false,
        args: attach_argv(&session),
        env: HashMap::new(),
        cwd: opts.cwd.clone(),
        cols: opts.cols,
        rows: opts.rows,
        local_only: true,
        sandbox: false,
        agent: false,
        project_id: None,
        schedule_target_id: None,
        host_session: false,
        remote_host_id: None,
        tmux_session: None,
        tmux_attach: None,
        host_bound_uid: None,
    };
    let mut cmd = build_command(&attach);
    if !std::path::Path::new(&attach.cwd).is_dir() {
        // The attach runs nothing in its cwd; never let a vanished one fail it.
        cmd.cwd(std::env::temp_dir());
    }
    let meta = PtyMeta {
        client: Some(client),
        local_tmux: None,
        attach_of: Some(opts.id.clone()),
    };
    // An attach PTY's own generation: no launch prepared it, so nothing
    // but its route and registry entry carries the number.
    let seq = crate::services::agent_fence::next_spawn_seq();
    launch(ctx.clone(), registry.clone(), &attach_id, cmd, attach.cols, attach.rows, meta, None, seq)?;
    Ok(TabJoin { attached: true, stale })
}

/// What [`join_tab`] did.
#[derive(Default)]
pub struct TabJoin {
    /// The client now has its own attach PTY: `pty_spawn` is done.
    pub attached: bool,
    /// The client's previous attach PTY, out of the registry, to tear down.
    pub stale: Option<TakenPty>,
}

/// Open a PTY of `cols`×`rows`, run `cmd` in it, register it under `id` and
/// stream it. `tab` is the tab's own spawn (its options): the bookkeeping that
/// follows a tab's process — Codex binding, MCP tokens, the fence — runs for
/// it alone; `None` is an attach PTY, whose events name `meta.attach_of`.
/// `seq` is the spawn's generation (`PreparedLaunch::spawn_seq` for a tab).
#[allow(clippy::too_many_arguments)]
fn launch(
    ctx: CoreCtx,
    registry: Arc<Mutex<PtyRegistry>>,
    id: &str,
    cmd: CommandBuilder,
    cols: u16,
    rows: u16,
    meta: PtyMeta,
    tab: Option<&PtyOptions>,
    seq: u64,
) -> Result<(), String> {
    let pty_system = NativePtySystem::default();

    // Never open a zero-size PTY. A 0-col/0-row size can slip in if the caller
    // spawns before xterm has measured a layout box; Unix ptys tolerate it but
    // Windows ConPTY accepts it silently and then emits no output, which shows up
    // as a black, dead agent tab. Clamp to a sane default so the child always has
    // a usable window — the frontend re-sends the real size via `pty_resize` as
    // soon as the pane is fitted.
    let cols = if cols == 0 { 80 } else { cols };
    let rows = if rows == 0 { 24 } else { rows };

    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {e}"))?;

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

    // The id the frontend knows this PTY by: the tab's, for an attach PTY too.
    let payload_id = meta.attach_of.clone().unwrap_or_else(|| id.to_string());
    let dead = Arc::new(AtomicBool::new(false));
    // A tab's own spawn goes in only while it is still the id's newest
    // (`insert_current_spawn`); an attach PTY is a viewer with no spawn of
    // its own to be superseded.
    let refused = {
        let mut reg = registry.lock_ok();
        if tab.is_some() {
            reg.insert_current_spawn(id.to_string(), pair.master, writer, child, dead.clone(), meta, seq)
                .err()
        } else {
            reg.insert_with(id.to_string(), pair.master, writer, child, dead.clone(), meta, seq);
            None
        }
    };
    if let Some(mut child) = refused {
        if let Some(pid) = child.process_id() {
            reap_child_subtree(pid, ReapMode::Graceful);
        }
        let _ = child.kill();
        return Err(format!("terminal '{id}': a newer start of this tab replaced this one"));
    }

    emit_pty_event(
        &ctx,
        id,
        "terminal-ready",
        TerminalReady {
            id: payload_id.clone(),
        },
    );

    // Channel: blocking reader thread → async emitter task.
    let (tx, rx) = tokio::sync::mpsc::channel::<Vec<u8>>(CHANNEL_CAP);

    let dead_reader = dead.clone();
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

    let id = id.to_string();
    let is_tab = tab.is_some();
    // Token for this *particular* spawn's Codex session tracking (None for any
    // tab the binder isn't following). A re-spawn under the same id replaces the
    // tracking and mints a new token, so the old process exiting below can only
    // ever tear down its own.
    let bind_seq = tab.and_then(|_| crate::services::codex_bind::current_seq(&id));
    let resume_seq = tab.and_then(|_| crate::services::codex_bind::resume_seq(&id));
    let route_seq = seq;
    if is_tab {
        route_open_at(&id, None, route_seq);
    } else {
        route_open_at(&id, Some(&payload_id), route_seq);
    }
    let env = tab.map(|opts| &opts.env);
    let mcp_token = env.and_then(|env| {
        env.get(crate::services::root_mcp::TOKEN_ENV)
            .or_else(|| env.get(crate::services::root_mcp::SCHEDULE_TOKEN_ENV))
            .cloned()
    });
    let help_token = env.and_then(|env| env.get(crate::services::root_mcp::HELP_TOKEN_ENV).cloned());
    let push_token = env.and_then(|env| env.get(crate::services::root_mcp::GIT_TOKEN_ENV).cloned());
    let markup_token = env.and_then(|env| env.get(crate::services::root_mcp::MARKUP_TOKEN_ENV).cloned());
    let web_token = env.and_then(|env| env.get(crate::services::root_mcp::WEB_TOKEN_ENV).cloned());
    tokio::spawn(async move {
        let emitter = ctx.clone();
        batch_output(rx, |bytes| match route_chunk(&id, bytes, route_seq) {
            Routed::Data(slice) => emit_output(&emitter, "terminal-output", &payload_id, slice),
            Routed::ArmDigest(tick) => arm_digest_tick(&emitter, tick),
            Routed::Quiet => {}
        })
        .await;
        match route_finish(&id, route_seq) {
            Routed::Data(slice) => emit_output(&emitter, "terminal-output", &payload_id, slice),
            Routed::ArmDigest(tick) => arm_digest_tick(&emitter, tick),
            Routed::Quiet => {}
        }
        // Who to tell the spawn ended, read before `route_close` may drop the
        // route (a server client's events go to the route's viewers).
        let exit_windows = per_client(&ctx).then(|| {
            routes()
                .lock_ok()
                .get(&id)
                .map(OutputRoute::event_windows)
                .unwrap_or_default()
        });
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
            if is_tab {
                crate::services::agent_fence::on_tab_gone(&id, route_seq);
            }
            // A login PTY whose login ended is no paste target any more.
            crate::commands::credentials::forget_login_pty_spawn(&id, route_seq);
            if let Some(token) = help_token {
                crate::services::root_mcp::revoke_token(&token);
            }
            if let Some(token) = push_token {
                crate::services::root_mcp::revoke_token(&token);
                ctx.emit(crate::services::git_push_mcp::CHANGED_EVENT, ());
            }
            if let Some(token) = markup_token {
                // The tab's open markup question goes with its session; the
                // sweep rings `markup-mcp-changed` through the change hook.
                crate::services::root_mcp::revoke_token(&token);
                crate::services::markup_mcp::sweep();
            }
            if let Some(token) = web_token {
                // The assistant's web lane: a chat's token dies with its CLI.
                crate::services::root_mcp::revoke_token(&token);
            }
            if let Some(token) = mcp_token {
                let state = crate::storage::state_dir();
                crate::services::root_mcp_review::on_spawn_gone(&state, &token);
                ctx.emit("root-mcp-review-changed", crate::services::root_mcp_review::pending_count(&state));
            }
            let exit = TerminalExit { id: payload_id, code: None };
            match exit_windows {
                Some(windows) => emit_to_windows(&ctx, &windows, "terminal-exit", &exit),
                None => ctx.emit("terminal-exit", exit),
            }
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
    // tokio's clock throughout, not std's: the deadline below is tokio's, and
    // mixing the two let a paused-clock test's window end in real time under
    // load (final review B9). At run time both read the same clock.
    let mut last_emit = tokio::time::Instant::now()
        .checked_sub(BATCH_INTERVAL)
        .unwrap_or_else(tokio::time::Instant::now);

    loop {
        if batch.is_empty() {
            match rx.recv().await {
                Some(data) => batch.extend_from_slice(&data),
                None => break, // Channel closed = reader thread exited.
            }
        } else {
            let deadline = last_emit + BATCH_INTERVAL;
            match tokio::time::timeout_at(deadline, rx.recv()).await {
                Ok(Some(data)) => batch.extend_from_slice(&data),
                Ok(None) => break,
                Err(_expired) => {} // Window over with data pending: flush below.
            }
        }

        let now = tokio::time::Instant::now();
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
    let mut reg = registry.lock_ok();
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

/// A registry entry running `sleep 60` under `id` with `meta`, for tests of
/// what owns a PTY (no output, no route, no tab bookkeeping).
#[cfg(all(test, unix))]
pub(crate) fn insert_test_pty(registry: &Arc<Mutex<PtyRegistry>>, id: &str, meta: PtyMeta) {
    insert_test_pty_at(registry, id, meta, 0);
}

/// [`insert_test_pty`] as spawn `seq` of `id`.
#[cfg(all(test, unix))]
pub(crate) fn insert_test_pty_at(registry: &Arc<Mutex<PtyRegistry>>, id: &str, meta: PtyMeta, seq: u64) {
    let pair = NativePtySystem::default()
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .expect("openpty");
    let mut cmd = CommandBuilder::new("sleep");
    cmd.arg("60");
    let child = pair.slave.spawn_command(cmd).expect("spawn sleep");
    let writer = pair.master.take_writer().expect("take writer");
    registry
        .lock()
        .unwrap()
        .insert_with(id.to_string(), pair.master, writer, child, Arc::new(AtomicBool::new(false)), meta, seq);
}

/// End every PTY a test left in `registry`, without the tab cleanups.
#[cfg(all(test, unix))]
pub(crate) fn kill_test_ptys(registry: &Arc<Mutex<PtyRegistry>>) {
    let mut reg = registry.lock().unwrap();
    for (_, mut entry) in reg.entries.drain() {
        entry.dead.store(true, Ordering::SeqCst);
        let _ = entry.child.kill();
        let _ = entry.child.wait();
    }
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
        route_remove_view(id, "test-view", 2, false);
        route_close(id, seq);
    }

    /// This route's digest alone (a tick's drain of only it), so a test never
    /// takes a sibling test's digest out of the shared map.
    fn take_digest(id: &str, at: Instant) -> Option<String> {
        let mut map = routes().lock().unwrap();
        let route = map.get_mut(id)?;
        if route.digest.is_empty() {
            return None;
        }
        route.last_digest = Some(at);
        Some(std::mem::take(&mut route.digest))
    }

    #[test]
    fn hidden_digests_leading_edge_then_coalesces() {
        let id = "route-t-digest";
        let seq = route_open(id);
        assert_eq!(set_visible(id, false), None);
        let mut clock = DigestClock::default();
        let t0 = Instant::now();
        let chunk = |bytes: &[u8], at: Instant, clock: &mut DigestClock| {
            let mut map = routes().lock().unwrap();
            route_chunk_in(&mut map, clock, id, bytes, at, seq)
        };
        // First hidden chunk after quiet: a tick at once (leading edge).
        let Routed::ArmDigest(tick) = chunk(b"abc", t0, &mut clock) else {
            panic!("the first hidden chunk arms a tick");
        };
        assert_eq!(tick.deadline, t0);
        assert!(clock.tick(tick.generation));
        assert_eq!(take_digest(id, t0).as_deref(), Some("abc"));
        // Inside the window: buffered, one tick armed for the window's end.
        let Routed::ArmDigest(tick) = chunk(b"def", t0 + Duration::from_millis(10), &mut clock)
        else {
            panic!("a chunk inside the window arms the window's end");
        };
        assert_eq!(tick.deadline, t0 + ACTIVITY_INTERVAL);
        assert!(matches!(
            chunk(b"ghi", t0 + Duration::from_millis(20), &mut clock),
            Routed::Quiet
        ));
        // The tick drains what the window accumulated — the decision prompt
        // that arrived right before quiet is never stranded.
        assert!(clock.tick(tick.generation));
        assert_eq!(take_digest(id, t0 + ACTIVITY_INTERVAL).as_deref(), Some("defghi"));
        assert_eq!(take_digest(id, t0 + ACTIVITY_INTERVAL), None);
        // Quiet for a window: the next chunk ticks at once again.
        let Routed::ArmDigest(tick) = chunk(b"jkl", t0 + ACTIVITY_INTERVAL * 2, &mut clock) else {
            panic!("a chunk after a quiet window ticks at once");
        };
        assert_eq!(tick.deadline, t0 + ACTIVITY_INTERVAL * 2);
        route_remove_view(id, "test-view", 2, false);
        route_close(id, seq);
    }

    /// A PTY's digests are never further apart than `max(ACTIVITY_INTERVAL,
    /// its chunk gap)` — the cadence its own timer gave it — while other
    /// hidden PTYs stream through the shared clock. Without this, a PTY
    /// speaking every 700 ms beside a continuous one was drained only at the
    /// other's window ends, up to 1 s apart: past `BUSY_WINDOW_MS`, so its
    /// pill flickered between working and idle.
    #[test]
    fn a_pty_keeps_its_own_cadence_beside_a_continuous_one() {
        let ms = Duration::from_millis;
        let hidden = || {
            let mut route = OutputRoute {
                seq: 1,
                ..Default::default()
            };
            route
                .visible_viewers
                .insert("v".to_string(), viewer(false, "main"));
            route
        };
        let mut map: HashMap<String, OutputRoute> = HashMap::new();
        for id in ["a", "b", "c"] {
            map.insert(id.to_string(), hidden());
        }
        let mut clock = DigestClock::default();
        let t0 = Instant::now();
        let chunk = |map: &mut HashMap<String, OutputRoute>,
                     clock: &mut DigestClock,
                     id: &str,
                     at: Duration| {
            match route_chunk_in(map, clock, id, b"x", t0 + at, 1) {
                Routed::ArmDigest(tick) => Some(tick),
                _ => None,
            }
        };
        let drain = |map: &mut HashMap<String, OutputRoute>,
                     clock: &mut DigestClock,
                     at: Duration,
                     tick: DigestTick| {
            digest_batch_take_in(map, t0 + at, clock, tick.generation)
                .into_iter()
                .map(|(id, _)| id)
                .collect::<Vec<_>>()
        };
        // Both speak at t0: one tick, at once, drains both.
        let tick = chunk(&mut map, &mut clock, "b", ms(0)).expect("the first chunk arms");
        assert_eq!(tick.deadline, t0);
        assert_eq!(chunk(&mut map, &mut clock, "a", ms(0)), None, "same tick");
        assert_eq!(drain(&mut map, &mut clock, ms(0), tick), ["a", "b"]);
        // B streams on through its windows; A is silent at the 500 ms tick.
        let tick = chunk(&mut map, &mut clock, "b", ms(10)).expect("window's end");
        assert_eq!(tick.deadline, t0 + ms(500));
        assert_eq!(drain(&mut map, &mut clock, ms(500), tick), ["b"]);
        let b_tick = chunk(&mut map, &mut clock, "b", ms(510)).expect("window's end");
        assert_eq!(b_tick.deadline, t0 + ms(1000));
        // A, drained at 0, speaks at 700: due at once, so it pulls the tick
        // forward instead of waiting for B's at 1000.
        let pulled = chunk(&mut map, &mut clock, "a", ms(700)).expect("pulled forward");
        assert_eq!(pulled.deadline, t0 + ms(700));
        assert_eq!(drain(&mut map, &mut clock, ms(700), pulled), ["a", "b"]);
        // B re-arms from the pulled tick's window; its superseded 1000 ms task
        // wakes to a newer generation and drains nothing.
        let tick = chunk(&mut map, &mut clock, "b", ms(710)).expect("window's end");
        assert_eq!(tick.deadline, t0 + ms(1200));
        assert!(drain(&mut map, &mut clock, ms(1000), b_tick).is_empty());
        assert_eq!(map["b"].digest, "x", "kept for the live tick");
        // A inside its own window (drained at 700, speaks at 1150) is due by
        // 1200, which the armed tick already covers.
        assert_eq!(chunk(&mut map, &mut clock, "a", ms(1150)), None);
        assert_eq!(drain(&mut map, &mut clock, ms(1200), tick), ["a", "b"]);
        // A's window end can be earlier than the armed tick too: C's leading
        // edge at 1450 ticks early (A silent, B drained), B arms 1950 from
        // it, and A speaking at 1600 — drained last at 1200 — is due by 1700,
        // so the tick is pulled to 1700, not left at 1950.
        let tick = chunk(&mut map, &mut clock, "b", ms(1210)).expect("window's end");
        assert_eq!(tick.deadline, t0 + ms(1700));
        let early = chunk(&mut map, &mut clock, "c", ms(1450)).expect("leading edge");
        assert_eq!(early.deadline, t0 + ms(1450));
        assert_eq!(drain(&mut map, &mut clock, ms(1450), early), ["b", "c"]);
        let tick = chunk(&mut map, &mut clock, "b", ms(1460)).expect("window's end");
        assert_eq!(tick.deadline, t0 + ms(1950));
        let pulled = chunk(&mut map, &mut clock, "a", ms(1600)).expect("pulled to A's window end");
        assert_eq!(pulled.deadline, t0 + ms(1700));
        assert_eq!(drain(&mut map, &mut clock, ms(1700), pulled), ["a", "b"]);
        assert!(drain(&mut map, &mut clock, ms(1950), tick).is_empty());
        // A's drains: 0, 700, 1200, 1700 — never more than its 700 ms gap apart.
    }

    /// One tick, one event: every hidden route with a digest is in it (§7.6);
    /// nothing due means no event at all.
    #[test]
    fn one_tick_batches_every_hidden_digest_due() {
        let hidden = |digest: &str| {
            let mut route = OutputRoute::default();
            route
                .visible_viewers
                .insert("v".to_string(), viewer(false, "main"));
            route.digest = digest.to_string();
            route
        };
        let mut map: HashMap<String, OutputRoute> = HashMap::new();
        map.insert("b".to_string(), hidden("two"));
        map.insert("a".to_string(), hidden("one"));
        map.insert("quiet".to_string(), hidden(""));
        let mut shown = hidden("streams live");
        shown
            .visible_viewers
            .insert("w".to_string(), viewer(true, "main"));
        map.insert("shown".to_string(), shown);
        let mut clock = DigestClock::default();
        let t0 = Instant::now();
        let tick = clock.arm(t0).expect("nothing armed yet");
        assert_eq!(
            digest_batch_take_in(&mut map, t0, &mut clock, tick.generation),
            vec![
                ("a".to_string(), "one".to_string()),
                ("b".to_string(), "two".to_string()),
            ]
        );
        // Each drained route knows its window now; the quiet one is still due
        // at once.
        assert_eq!(map["a"].last_digest, Some(t0));
        assert_eq!(map["quiet"].last_digest, None);
        assert_eq!(map["a"].digest_due_by(t0 + Duration::from_millis(100)), t0 + ACTIVITY_INTERVAL);
        assert_eq!(map["quiet"].digest_due_by(t0 + Duration::from_millis(100)), t0 + Duration::from_millis(100));
        // Drained: nothing due, no event. A shown route is never digested.
        let tick = clock.arm(t0).expect("the tick disarmed the clock");
        assert!(digest_batch_take_in(&mut map, t0, &mut clock, tick.generation).is_empty());
        assert_eq!(map["shown"].digest, "streams live");
        // One tick covers every deadline at or past it; an earlier deadline
        // supersedes it, and the superseded generation drains nothing.
        let later = clock.arm(t0 + ACTIVITY_INTERVAL).expect("nothing armed");
        assert_eq!(clock.arm(t0 + ACTIVITY_INTERVAL), None);
        assert_eq!(clock.arm(t0 + ACTIVITY_INTERVAL * 2), None);
        let earlier = clock.arm(t0 + Duration::from_millis(100)).expect("pulled forward");
        assert_eq!(earlier.deadline, t0 + Duration::from_millis(100));
        assert!(!clock.tick(later.generation));
        assert!(clock.tick(earlier.generation));
        assert!(clock.arm(t0 + ACTIVITY_INTERVAL * 3).is_some(), "disarmed by the tick");
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
        assert_eq!(take_digest(id, t0), None);
        route_remove_view(id, "test-view", 2, false);
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
        // Released: back to buffering (a digest tick armed again).
        let t1 = t0 + ACTIVITY_INTERVAL * 2;
        let armed = {
            let mut map = routes().lock().unwrap();
            route_chunk_in(&mut map, &mut DigestClock::default(), id, b"after", t1, seq)
        };
        assert!(matches!(armed, Routed::ArmDigest(t) if t.deadline == t1));
        assert_eq!(take_digest(id, t1).as_deref(), Some("after"));
        route_remove_view(id, "test-view", 2, false);
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

    /// A long hidden spell replays from its last full clear, with the modes
    /// the dropped frames switched on re-applied in front (§3.2b).
    #[test]
    fn showing_replays_from_the_last_clear_with_the_modes_in_front() {
        let id = "route-t-replay-trim";
        let seq = route_open(id);
        set_visible(id, false);
        let t0 = Instant::now();
        let _ = route_chunk_at(id, b"\x1b[?1049h\x1b[?1000h\x1b[?2004h", t0, seq);
        let dead = "dead frame ".repeat(REPLAY_TRIM_FLOOR / 10);
        let _ = route_chunk_at(id, dead.as_bytes(), t0, seq);
        let _ = route_chunk_at(id, b"\x1b[?1000l\x1b[2J\x1b[Hlast frame", t0, seq);
        assert_eq!(
            set_visible(id, true).as_deref(),
            Some("\x1b[?1049h\x1b[?1000l\x1b[?2004h\x1b[2J\x1b[Hlast frame")
        );
        route_remove_view(id, "test-view", 2, false);
        route_close(id, seq);
    }

    /// A short spell replays whole, even across a clear: nothing to save.
    #[test]
    fn a_short_hidden_spell_replays_whole() {
        let id = "route-t-replay-short";
        let seq = route_open(id);
        set_visible(id, false);
        let t0 = Instant::now();
        let _ = route_chunk_at(id, b"\x1b[?1000hold\x1b[2J\x1b[Hnew", t0, seq);
        assert_eq!(
            set_visible(id, true).as_deref(),
            Some("\x1b[?1000hold\x1b[2J\x1b[Hnew")
        );
        route_remove_view(id, "test-view", 2, false);
        route_close(id, seq);
    }

    /// A mode switch the pending cap already trimmed off still reaches the
    /// replay: the cut-off front is folded into the route's carried state.
    #[test]
    fn a_mode_trimmed_off_by_the_cap_still_replays() {
        let mut route = OutputRoute::default();
        let push = |route: &mut OutputRoute, text: &str| {
            let slice = route.retain(text.to_string());
            route.push_pending(&slice);
        };
        push(&mut route, "\x1b[?1049h\x1b[?2004h");
        push(&mut route, &"x".repeat(ROUTE_PENDING_CAP * 2));
        assert_eq!(route.pending.len(), ROUTE_PENDING_CAP, "the cap cut the front off");
        assert!(!route.carried.is_empty(), "…and kept what it switched on");
        push(&mut route, "\x1b[2J\x1b[Hframe");
        let replay = route.take_pending().unwrap().text;
        assert_eq!(replay, "\x1b[?1049h\x1b[?2004h\x1b[2J\x1b[Hframe");
        assert!(route.carried.is_empty(), "spent by the replay");
    }

    /// A respawn under the same id is a new program: what the cap trimmed
    /// off its predecessor's buffer is not its state. Replaying it put xterm
    /// on the old program's alternate screen for the new one's output.
    #[test]
    fn a_respawn_drops_the_state_carried_from_its_predecessor() {
        let id = "route-t-carried-respawn";
        let seq = route_open(id);
        set_visible(id, false);
        let t0 = Instant::now();
        let _ = route_chunk_at(id, b"\x1b[?1049h\x1b[?1000h", t0, seq);
        let _ = route_chunk_at(id, "x".repeat(ROUTE_PENDING_CAP * 2).as_bytes(), t0, seq);
        assert!(!routes().lock().unwrap()[id].carried.is_empty(), "the cap folded the modes");
        let seq2 = route_open(id);
        let _ = route_chunk_at(id, b"fresh", t0, seq2);
        assert_eq!(set_visible(id, true).as_deref(), Some("fresh"));
        route_remove_view(id, "test-view", 2, false);
        route_close(id, seq2);
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
        route_remove_view(id, "test-view", 2, false);
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
        route_remove_view(id, "test-view", 2, false);
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
        route_remove_view(id, "test-view", 2, false);
        route_close(id, new);
    }

    /// Sleeping tabs (§5.3): a pane put to sleep leaves with `sleeping`, and
    /// its PTY's catch-up tail grows to the sleep cap — the wake repaints from
    /// it alone, there being no xterm left that holds the history.
    #[test]
    fn a_sleeping_pane_keeps_the_longer_tail_until_it_wakes() {
        let id = "route-t-sleep-cap";
        let seq = route_open(id);
        set_visible(id, true);
        route_remove_view(id, "test-view", 2, true);
        let chunk = "x".repeat(100_000);
        for _ in 0..8 {
            route_chunk_at(id, chunk.as_bytes(), Instant::now(), seq);
        }
        assert_eq!(
            route_scrollback(id).data.len(),
            800_000,
            "past the awake bound of 2x {ROUTE_SCROLLBACK_CAP}, all of it kept"
        );

        // The wake registers its view, then reads: the whole tail (no clear in
        // it to cut at), and the route is awake again.
        set_visible(id, true);
        assert_eq!(route_wake_scrollback(id).data.len(), 800_000);
        assert!(!routes().lock().unwrap().get(id).unwrap().asleep);
        route_chunk_at(id, b"y", Instant::now(), seq);
        assert!(
            route_scrollback(id).data.len() <= ROUTE_SCROLLBACK_CAP * 2,
            "back to the ordinary cap once awake"
        );

        set_visible(id, false);
        route_remove_view(id, "test-view", 3, false);
        route_close(id, seq);
        assert!(!routes().lock().unwrap().contains_key(id));
    }

    /// A pane woken while hidden reads the tail, which already holds what the
    /// hidden-spell buffer has: its first show must not replay it again.
    #[test]
    fn a_hidden_wake_is_not_replayed_the_same_output_on_show() {
        let id = "route-t-sleep-hidden-wake";
        let seq = route_open(id);
        set_visible(id, true);
        route_remove_view(id, "test-view", 2, true);
        route_chunk_at(id, b"while asleep\r\n", Instant::now(), seq);
        // Woken hidden: the view registers hidden, then reads.
        set_visible(id, false);
        assert!(route_wake_scrollback(id).data.contains("while asleep"));
        assert_eq!(set_visible(id, true), None, "nothing to replay on show");
        route_chunk_at(id, b"later", Instant::now(), seq);
        set_visible(id, false);
        route_chunk_at(id, b"hidden again", Instant::now(), seq);
        assert_eq!(set_visible(id, true).as_deref(), Some("hidden again"));

        set_visible(id, false);
        route_remove_view(id, "test-view", 3, false);
        route_close(id, seq);
    }

    /// A program that ends while its pane sleeps has nobody to tell: the route
    /// (and its tail) outlives the spawn so the wake shows the output and that
    /// it exited. Before, a viewless route was dropped at the spawn's end and
    /// the woken pane came up blank.
    #[test]
    fn a_spawn_that_ends_asleep_keeps_its_tail_for_the_wake() {
        let id = "route-t-sleep-exit";
        let seq = route_open(id);
        set_visible(id, true);
        route_chunk_at(id, b"build done\r\n", Instant::now(), seq);
        route_remove_view(id, "test-view", 2, true);
        route_chunk_at(id, b"bye\r\n", Instant::now(), seq);
        assert!(route_close(id, seq), "the current spawn ends");
        assert!(routes().lock().unwrap().contains_key(id), "kept for the wake");

        set_visible(id, true);
        let wake = route_wake_scrollback(id);
        assert!(wake.data.contains("build done") && wake.data.contains("bye"));
        assert!(wake.exited, "the wake learns the program ended");
        // The woken pane's eventual close collects the route as before.
        route_remove_view(id, "test-view", 3, false);
        assert!(!routes().lock().unwrap().contains_key(id));
    }

    /// Closing a sleeping tab (`pty_kill` → `route_forget_sleep`): nothing
    /// waits for a wake any more, so the route goes with the spawn — at once
    /// when the spawn already ended, at its end when it is still running.
    #[test]
    fn closing_a_sleeping_tab_forgets_its_route() {
        let ended = "route-t-sleep-close-ended";
        let seq = route_open(ended);
        set_visible(ended, true);
        route_remove_view(ended, "test-view", 2, true);
        route_close(ended, seq);
        assert!(routes().lock().unwrap().contains_key(ended));
        route_forget_sleep(ended);
        assert!(!routes().lock().unwrap().contains_key(ended), "dropped at once");

        let live = "route-t-sleep-close-live";
        let seq = route_open(live);
        set_visible(live, true);
        route_remove_view(live, "test-view", 2, true);
        route_forget_sleep(live);
        assert!(routes().lock().unwrap().contains_key(live), "still running");
        route_close(live, seq);
        assert!(!routes().lock().unwrap().contains_key(live), "gone with its spawn");
    }

    /// An ordinary close (no `sleeping`) still collects an ended route, and a
    /// popout's catch-up read leaves a sleeping route asleep.
    #[test]
    fn only_the_wake_read_ends_a_routes_sleep() {
        let id = "route-t-sleep-popout-read";
        let seq = route_open(id);
        set_visible(id, true);
        route_remove_view(id, "test-view", 2, true);
        let _ = route_scrollback(id);
        assert!(routes().lock().unwrap().get(id).unwrap().asleep);
        let _ = route_wake_scrollback(id);
        assert!(!routes().lock().unwrap().get(id).unwrap().asleep);
        route_close(id, seq);
        assert!(!routes().lock().unwrap().contains_key(id));
    }

    /// The modes a TUI switched on at its start fall off a long session's
    /// tail; a woken pane's fresh xterm (and a popout's) must still get them,
    /// or it pastes without bracketed-paste markers — a multi-line paste into
    /// an agent woken from sleep submitted its first line. The cap's cut-off
    /// front is folded into the route's carried state and written ahead of the
    /// tail by both reads; a respawn drops it.
    #[test]
    fn a_catch_up_keeps_the_modes_the_tail_cap_cut_off() {
        let id = "route-t-sleep-carried-modes";
        let seq = route_open(id);
        set_visible(id, true);
        route_chunk_at(id, b"\x1b[?2004h\x1b[?1049h", Instant::now(), seq);
        let filler = "y".repeat(100_000);
        for _ in 0..6 {
            route_chunk_at(id, filler.as_bytes(), Instant::now(), seq);
        }
        let popout = route_scrollback(id);
        assert!(popout.data.len() < 600_000, "the cap cut the front off");
        assert!(popout.data.starts_with("\x1b[?2004h\x1b[?1049h"), "the popout read carries the modes");

        route_remove_view(id, "test-view", 2, true);
        set_visible(id, true);
        let wake = route_wake_scrollback(id);
        assert!(wake.data.starts_with("\x1b[?2004h\x1b[?1049h"), "so does the wake");
        assert!(wake.data.ends_with('y'));

        // A respawn is a new program: the predecessor's modes are not its own.
        let seq2 = route_open(id);
        route_chunk_at(id, b"fresh", Instant::now(), seq2);
        assert_eq!(route_scrollback(id).data, "fresh");

        set_visible(id, false);
        route_remove_view(id, "test-view", 3, false);
        route_close(id, seq);
        route_close(id, seq2);
    }

    /// The wake's catch-up is cut at the last full clear, as a hidden spell's
    /// replay is: a TUI's megabyte of redraws arrives as its last frame. The
    /// popout's read of the same tail stays whole.
    #[test]
    fn the_wake_tail_is_cut_at_the_last_clear() {
        let id = "route-t-sleep-trim";
        let seq = route_open(id);
        set_visible(id, true);
        route_remove_view(id, "test-view", 2, true);
        let frame = format!("\x1b[2J\x1b[3J\x1b[H{}", "old frame ".repeat(1000));
        for _ in 0..20 {
            route_chunk_at(id, frame.as_bytes(), Instant::now(), seq);
        }
        route_chunk_at(id, b"\x1b[2J\x1b[3J\x1b[Hlast frame", Instant::now(), seq);
        let whole = route_scrollback(id);
        assert!(whole.data.len() > REPLAY_TRIM_FLOOR);

        set_visible(id, true);
        let wake = route_wake_scrollback(id);
        assert!(wake.data.ends_with("last frame"));
        assert!(!wake.data.contains("old frame"), "cut at the last clear");
        assert_eq!(wake.end_offset, whole.end_offset, "offsets cover the same range");
        assert!(!wake.exited);

        set_visible(id, false);
        route_remove_view(id, "test-view", 3, false);
        route_close(id, seq);
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
        assert!(reg.insert_current_spawn(id.into(), master, writer, child, Arc::new(AtomicBool::new(false)), PtyMeta::default(), old).is_ok());
        assert!(agent_fence::register_tab(id, None, old));
        // The respawn begins and claims the Codex session it resumes.
        let new = agent_fence::begin_spawn(id);
        let mut opts = PtyOptions {
            login: None,
            assistant: None,
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
        assert!(reg.insert_current_spawn(id.into(), master, writer, child, Arc::new(AtomicBool::new(false)), PtyMeta::default(), new).is_ok());
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
        assert!(reg.insert_current_spawn(id.into(), master, writer, child, Arc::new(AtomicBool::new(false)), PtyMeta::default(), newer).is_ok());
        let (master, writer, child) = sleeper();
        let mut refused = reg
            .insert_current_spawn(id.into(), master, writer, child, Arc::new(AtomicBool::new(false)), PtyMeta::default(), older)
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

/// TODO #2347 / #2345: one PTY per server client on a tab, its events routed
/// to that client alone; the desktop's path unchanged.
#[cfg(test)]
mod client_tests {
    use super::*;
    use app_core::{CoreState, RecordingEvents};

    fn ctx_as(caller: Caller, events: Arc<RecordingEvents>) -> CoreCtx {
        CoreCtx::new(Arc::new(CoreState::new()), events, caller)
    }

    fn web(n: u32) -> ClientId {
        ClientId::new(format!("web-{n}"))
    }

    fn view(map: &mut HashMap<String, OutputRoute>, id: &str, viewer: &str, window: &str) {
        map.entry(id.to_string()).or_default().visible_viewers.insert(
            viewer.to_string(),
            ViewerReg { visible: true, seq: 1, window: window.to_string() },
        );
    }

    /// #2345: a server client's chunk is one frame, to the client viewing the
    /// PTY, under the plain name — no `:<label>` copy, no broadcast.
    #[test]
    fn a_server_clients_chunk_is_one_frame_to_its_viewer_only() {
        let id = "client-t:one-frame";
        let seq = route_open(id);
        view(&mut routes().lock().unwrap(), id, "v1", "web-1");
        let events = RecordingEvents::new();
        let ctx = ctx_as(Caller::Client(web(1)), events.clone());
        match route_chunk_at(id, b"hi", Instant::now(), seq) {
            Routed::Data(slice) => emit_output(&ctx, "terminal-output", id, slice),
            other => panic!("expected data, got {other:?}"),
        }
        let sent = events.take();
        assert_eq!(sent.len(), 1, "{sent:?}");
        assert_eq!(sent[0].client, Some(web(1)));
        assert_eq!(sent[0].event, "terminal-output");
        assert!(sent[0].payload.contains(r#""id":"client-t:one-frame""#), "{}", sent[0].payload);
        routes().lock().unwrap().remove(id);
    }

    /// The activity batch: on a server each viewing client gets only its own
    /// routes' entries, an attach route's under its tab's id; the desktop
    /// gets one broadcast of every entry.
    #[test]
    fn a_server_clients_activity_batch_holds_only_its_routes() {
        let mut map = HashMap::new();
        view(&mut map, "tab-a", "v1", "web-1");
        view(&mut map, "tab-b@web-2", "v2", "web-2");
        map.get_mut("tab-b@web-2").unwrap().tab = Some("tab-b".into());
        let batch = vec![("tab-a".to_string(), "aa".to_string()), ("tab-b@web-2".to_string(), "bb".to_string()), ("gone".to_string(), "zz".to_string())];
        let addressed = address_digest_batch(&map, batch);
        assert_eq!(addressed[1].0.id, "tab-b", "an attach route's entry names its tab");

        let events = RecordingEvents::new();
        emit_activity_batch(&ctx_as(Caller::Client(web(1)), events.clone()), addressed.clone());
        let sent = events.take();
        assert_eq!(sent.len(), 2, "{sent:?}");
        assert_eq!((sent[0].client.clone(), sent[0].event.as_str()), (Some(web(1)), "terminal-activity-batch"));
        assert!(sent[0].payload.contains(r#""id":"tab-a""#) && !sent[0].payload.contains("bb"), "{}", sent[0].payload);
        assert_eq!(sent[1].client, Some(web(2)));
        assert!(sent[1].payload.contains(r#""id":"tab-b""#) && !sent[1].payload.contains("aa"), "{}", sent[1].payload);
        assert!(!sent.iter().any(|e| e.payload.contains("zz")), "a route nobody views reaches nobody");

        let events = RecordingEvents::new();
        emit_activity_batch(&ctx_as(Caller::Local(ClientId::main()), events.clone()), addressed);
        let sent = events.take();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].client, None, "the desktop's batch is one broadcast");
        for data in ["aa", "bb", "zz"] {
            assert!(sent[0].payload.contains(data), "{}", sent[0].payload);
        }
    }

    /// A server client's pane put to sleep has no view, yet its tab still
    /// shows activity: its window stays addressed for the PTY's events (not
    /// its output) until it wakes, or until it leaves — which ends the sleep,
    /// as no wake will come.
    #[test]
    fn a_sleeping_server_pane_hears_its_events_until_it_wakes_or_leaves() {
        let id = "client-t:sleeper";
        let seq = route_open(id);
        {
            let mut map = routes().lock().unwrap();
            view(&mut map, id, "v1", "web-91");
            view(&mut map, id, "v2", "web-92");
        }
        let windows = |f: fn(&OutputRoute) -> Vec<String>| f(&routes().lock().unwrap()[id]);
        let both = vec!["web-92".to_string(), "web-91".to_string()];

        route_remove_view(id, "v1", 2, true);
        assert_eq!(windows(OutputRoute::viewer_windows), vec!["web-92".to_string()], "no output without an xterm");
        assert_eq!(windows(OutputRoute::event_windows), both);
        let addressed = address_digest_batch(&routes().lock().unwrap(), vec![(id.to_string(), "x".to_string())]);
        assert_eq!(addressed[0].1, both, "the sleeping tab's activity reaches it");

        // The wake registers its view, then reads: one window, awake.
        view(&mut routes().lock().unwrap(), id, "v1", "web-91");
        route_wake_scrollback(id);
        assert!(routes().lock().unwrap()[id].sleepers.is_empty());

        // Asleep again, then the page goes: nobody is left to wake it.
        route_remove_view(id, "v1", 3, true);
        route_drop_window_views("web-91");
        let route_asleep = routes().lock().unwrap()[id].asleep;
        assert!(!route_asleep, "a gone sleeper's route closes with its spawn");
        assert_eq!(windows(OutputRoute::event_windows), vec!["web-92".to_string()]);

        route_remove_view(id, "v2", 3, false);
        route_close(id, seq);
        assert!(!routes().lock().unwrap().contains_key(id));
    }

    /// The desktop keeps its broadcast: the main window hears every chunk under
    /// the plain name, a popout its own copy under `<event>:<label>`.
    #[test]
    fn a_desktop_windows_chunk_is_still_broadcast_with_popout_copies() {
        let id = "client-t:desktop";
        let seq = route_open(id);
        {
            let mut map = routes().lock().unwrap();
            view(&mut map, id, "main-view", "main");
            view(&mut map, id, "pop", "detached-p-1");
        }
        let events = RecordingEvents::new();
        let ctx = ctx_as(Caller::Local(ClientId::main()), events.clone());
        match route_chunk_at(id, b"hi", Instant::now(), seq) {
            Routed::Data(slice) => emit_output(&ctx, "terminal-output", id, slice),
            other => panic!("expected data, got {other:?}"),
        }
        let sent: Vec<(Option<ClientId>, String)> = events.take().into_iter().map(|e| (e.client, e.event)).collect();
        assert_eq!(
            sent,
            vec![
                (None, "terminal-output:detached-p-1".to_string()),
                (None, "terminal-output".to_string()),
            ]
        );
        routes().lock().unwrap().remove(id);
    }

    /// An attach route's replay names the tab, which is all its client knows.
    #[test]
    fn an_attach_routes_replay_names_the_tab() {
        let tab = "client-t:replay";
        let attach = attach_pty_id(tab, &web(2));
        let seq = crate::services::agent_fence::next_spawn_seq();
        route_open_at(&attach, Some(tab), seq);
        route_chunk_at(&attach, b"while hidden", Instant::now(), seq);
        let events = RecordingEvents::new();
        let ctx = ctx_as(Caller::Client(web(2)), events.clone());
        route_set_visible(&ctx, &attach, "v2", true, 1, "web-2");
        let sent = events.take();
        assert_eq!(sent.len(), 1, "{sent:?}");
        assert_eq!((sent[0].client.clone(), sent[0].event.as_str()), (Some(web(2)), "terminal-replay"));
        assert!(sent[0].payload.contains(r#""id":"client-t:replay""#), "{}", sent[0].payload);
        assert!(sent[0].payload.contains("while hidden"));
        routes().lock().unwrap().remove(&attach);
    }

    /// A client's registrations follow the PTY that serves it; another client's
    /// stay where they are.
    #[test]
    fn moving_a_windows_views_leaves_the_others() {
        let tab = "client-t:move";
        let attach = attach_pty_id(tab, &web(2));
        let seq = route_open(tab);
        {
            let mut map = routes().lock().unwrap();
            view(&mut map, tab, "v1", "web-1");
            view(&mut map, tab, "v2", "web-2");
        }
        route_move_window_views(tab, &attach, "web-2");
        {
            let map = routes().lock().unwrap();
            assert_eq!(map[tab].viewer_windows(), vec!["web-1".to_string()]);
            assert_eq!(map[&attach].viewer_windows(), vec!["web-2".to_string()]);
        }
        route_close(tab, seq);
        let mut map = routes().lock().unwrap();
        map.remove(tab);
        map.remove(&attach);
    }

    #[cfg(unix)]
    #[test]
    fn a_client_resolves_to_its_own_attach_and_a_gone_owner_hands_the_tab_over() {
        let registry: Arc<Mutex<PtyRegistry>> = Arc::default();
        let tab = "client-t:own";
        insert_test_pty(
            &registry,
            tab,
            PtyMeta { client: Some(web(1)), local_tmux: Some("s".into()), attach_of: None },
        );
        let attach = attach_pty_id(tab, &web(2));
        {
            let mut reg = registry.lock().unwrap();
            // The owner respawns its own; another client joins.
            assert_eq!(reg.attachable(tab, &web(1)), None);
            assert_eq!(reg.attachable(tab, &web(2)).as_deref(), Some("s"));
            // Before it spawns, web-2's pane already speaks for its own stream.
            assert_eq!(reg.resolve(&Caller::Client(web(2)), tab), attach);
            assert_eq!(reg.resolve(&Caller::Client(web(1)), tab), tab);
        }
        insert_test_pty(
            &registry,
            &attach,
            PtyMeta { client: Some(web(2)), local_tmux: None, attach_of: Some(tab.into()) },
        );
        resize_pty(&registry, &attach, 61, 21).unwrap();
        {
            let mut reg = registry.lock().unwrap();
            assert_eq!(reg.resolve(&Caller::Client(web(2)), tab), attach);
            assert_eq!(reg.resolve(&Caller::Client(web(1)), tab), tab);
            assert_eq!(reg.resolve(&Caller::Local(ClientId::main()), tab), tab);
        }
        // The owner is gone for good while web-2 still looks: the tab PTY is
        // web-2's now, at web-2's size; nothing is taken.
        let taken = registry.lock().unwrap().release_client(&web(1));
        assert!(taken.is_empty());
        {
            let reg = registry.lock().unwrap();
            let entry = &reg.entries[tab];
            assert_eq!(entry.meta.client, Some(web(2)));
            let size = entry.master.get_size().unwrap();
            assert_eq!((size.cols, size.rows), (61, 21));
        }
        // A foreign attach PTY, named by its (guessable) id, is not web-1's
        // to address; nor may anyone spawn over it.
        {
            let mut reg = registry.lock().unwrap();
            let foreign = reg.resolve(&Caller::Client(web(1)), &attach);
            assert_ne!(foreign, attach);
            assert!(!reg.entries.contains_key(&foreign), "names nothing");
            assert_eq!(reg.resolve(&Caller::Client(web(2)), &attach), attach, "its own client may");
        }
        let ctx1 = ctx_as(Caller::Client(web(1)), RecordingEvents::new());
        let spawn_over = PtyOptions { id: attach.clone(), ..test_opts() };
        assert!(join_tab(&ctx1, &registry, &spawn_over, |_| Vec::new()).is_err());
        // web-2 goes too: its attach is taken; the tab PTY, a tmux client
        // nobody looks at, is left to nobody — the session and the tab's
        // bookkeeping live on — and the next page attaches to it.
        let taken = registry.lock().unwrap().release_client(&web(2));
        let ids: Vec<String> = taken.iter().map(|t| t.id.clone()).collect();
        assert_eq!(ids, vec![attach.clone()]);
        for mut t in taken {
            let _ = t.entry.child.kill();
        }
        {
            let mut reg = registry.lock().unwrap();
            assert_eq!(reg.entries[tab].meta.client, None);
            assert_eq!(reg.attachable(tab, &web(3)).as_deref(), Some("s"));
            assert_eq!(reg.resolve(&Caller::Client(web(3)), tab), attach_pty_id(tab, &web(3)));
            // Its session ends: the next release sweeps it up.
            let entry = reg.entries.get_mut(tab).unwrap();
            let _ = entry.child.kill();
            let _ = entry.child.wait();
            assert!(reg.release_client(&web(9)).iter().any(|t| t.id == tab));
            assert!(!reg.entries.contains_key(tab));
        }
        kill_test_ptys(&registry);
    }

    #[cfg(unix)]
    fn test_opts() -> PtyOptions {
        PtyOptions {
            login: None,
            assistant: None,
            id: String::new(),
            cmd: "sh".to_string(),
            local_model: false,
            args: Vec::new(),
            env: HashMap::new(),
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
            cols: 80,
            rows: 24,
            local_only: true,
            sandbox: false,
            agent: false,
            project_id: None,
            schedule_target_id: None,
            host_session: false,
            remote_host_id: None,
            tmux_session: None,
            tmux_attach: None,
            host_bound_uid: None,
        }
    }

    /// A tab no local tmux holds has one PTY every page shares: the page that
    /// spawned it leaving must not kill it under a page still viewing it.
    #[cfg(unix)]
    #[test]
    fn a_shared_pty_passes_to_a_page_still_viewing_it() {
        let registry: Arc<Mutex<PtyRegistry>> = Arc::default();
        let tab = "client-t:shared";
        insert_test_pty(&registry, tab, PtyMeta { client: Some(web(71)), ..PtyMeta::default() });
        let seq = route_open(tab);
        {
            let mut map = routes().lock().unwrap();
            view(&mut map, tab, "v1", "web-71");
            view(&mut map, tab, "v2", "web-72");
        }
        route_drop_window_views("web-71");
        assert!(registry.lock().unwrap().release_client(&web(71)).is_empty());
        assert_eq!(registry.lock().unwrap().entries[tab].meta.client, Some(web(72)));
        // The last viewer goes: no tmux session holds it, so it ends.
        route_drop_window_views("web-72");
        let taken = registry.lock().unwrap().release_client(&web(72));
        assert_eq!(taken.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), vec![tab]);
        for mut t in taken {
            let _ = t.entry.child.kill();
        }
        route_close(tab, seq);
        routes().lock().unwrap().remove(tab);
        kill_test_ptys(&registry);
    }

    /// The assistant's web-lane token is revoked when its process ends, like the
    /// help, push and markup tokens: a finished chat's bearer opens nothing.
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_chats_web_lane_token_dies_with_its_process() {
        use crate::services::root_mcp::{authenticate, test_session_for_tab, WEB_TOKEN_ENV};
        let (token, _) = test_session_for_tab(crate::services::root_mcp::Caller::Web, "assistant:revoke-t", std::path::Path::new("/nonexistent"));
        let header = format!("Bearer {token}");
        assert!(authenticate(Some(&header)).is_some(), "minted");
        let tab = "assistant:revoke-t";
        let opts = PtyOptions {
            login: None,
            assistant: None,
            id: tab.to_string(),
            cmd: "sh".to_string(),
            local_model: false,
            args: vec!["-c".to_string(), "exit 0".to_string()],
            env: HashMap::from([(WEB_TOKEN_ENV.to_string(), token.clone())]),
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
            cols: 80,
            rows: 24,
            local_only: true,
            sandbox: false,
            agent: false,
            project_id: None,
            schedule_target_id: None,
            host_session: false,
            remote_host_id: None,
            tmux_session: None,
            tmux_attach: None,
            host_bound_uid: None,
        };
        let registry: Arc<Mutex<PtyRegistry>> = Arc::default();
        let ctx = ctx_as(Caller::Local(ClientId::main()), RecordingEvents::new());
        let seq = crate::services::agent_fence::begin_spawn(tab);
        spawn_pty(ctx, registry, opts, seq).unwrap();
        for _ in 0..200 {
            if authenticate(Some(&header)).is_none() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("the web token still opens the lane after its process ended");
    }

    /// The whole of #2347 against a real tmux server of the test's own (`-L`,
    /// no config): two clients on one tab, each its own size; output to each
    /// client from its own PTY only; one client closing leaves the other's
    /// view and the session; a gone owner hands the tab over.
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn two_clients_on_one_tmux_tab_each_get_their_own_size_and_stream() {
        if !crate::services::tmux_local::tmux_available() {
            eprintln!("tmux not installed; skipping");
            return;
        }
        let socket = format!("t2347-{}", std::process::id());
        let session = "t2347";
        let tmux = |args: &[&str]| -> String {
            let out = std::process::Command::new("tmux")
                .args(["-L", &socket, "-f", "/dev/null"])
                .args(args)
                .output()
                .expect("tmux");
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        let clients = || {
            let mut sizes: Vec<String> = tmux(&["list-clients", "-t", &format!("={session}"), "-F", "#{client_width}x#{client_height}"])
                .lines()
                .map(str::to_string)
                .collect();
            sizes.sort();
            sizes
        };
        let wait_for = |what: &str, ok: &dyn Fn() -> bool| {
            for _ in 0..200 {
                if ok() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            panic!("timed out waiting for {what}");
        };

        let registry: Arc<Mutex<PtyRegistry>> = Arc::default();
        let events = RecordingEvents::new();
        let ctx1 = ctx_as(Caller::Client(web(81)), events.clone());
        let ctx2 = ctx_as(Caller::Client(web(82)), events.clone());
        let tab = "client-t:tmux";
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();
        let policy = crate::services::tmux_local::window_size_policy(true);
        let opts = |cols: u16, rows: u16| PtyOptions {
            login: None,
            assistant: None,
            id: tab.to_string(),
            cmd: "tmux".to_string(),
            local_model: false,
            args: [
                "-L", &socket, "-f", "/dev/null", "new-session", "-A", "-s", session, "cat", ";",
                "set-option", "-t", session, "status", "off", ";",
                "set-window-option", "-t", session, "window-size", policy,
            ]
            .iter()
            .map(|s| s.to_string())
            .collect(),
            env: HashMap::new(),
            cwd: cwd.clone(),
            cols,
            rows,
            local_only: true,
            sandbox: false,
            agent: false,
            project_id: None,
            schedule_target_id: None,
            host_session: false,
            remote_host_id: None,
            tmux_session: Some(session.to_string()),
            tmux_attach: None,
            host_bound_uid: None,
        };
        let attach_argv = |s: &str| -> Vec<String> {
            ["-L", &socket, "-f", "/dev/null", "attach-session", "-t", &format!("={s}")]
                .iter()
                .map(|a| a.to_string())
                .collect()
        };

        // Page 1 opens the tab: the ordinary spawn, the tab's own PTY.
        route_set_visible(&ctx1, tab, "v1", true, 1, "web-81");
        let join = join_tab(&ctx1, &registry, &opts(100, 30), attach_argv).unwrap();
        assert!(!join.attached && join.stale.is_none(), "nothing to join yet");
        let seq = crate::services::agent_fence::begin_spawn(tab);
        spawn_pty(ctx1.clone(), registry.clone(), opts(100, 30), seq).unwrap();
        wait_for("the first client", &|| clients() == ["100x30"]);

        // Page 2 opens the same tab: a tmux client of its own, at its size.
        // Its pane registers first, as `pty_set_visible` does: on its own
        // stream already, never on page 1's.
        let attach = attach_pty_id(tab, &web(82));
        let view_id = registry.lock().unwrap().resolve(&ctx2.caller, tab);
        assert_eq!(view_id, attach);
        route_set_visible(&ctx2, &view_id, "v2", true, 1, "web-82");
        let join = join_tab(&ctx2, &registry, &opts(60, 20), attach_argv).unwrap();
        assert!(join.attached);
        assert_eq!(registry.lock().unwrap().resolve(&Caller::Client(web(82)), tab), attach);
        assert_eq!(routes().lock().unwrap()[tab].viewer_windows(), vec!["web-81".to_string()]);
        wait_for("both clients, each its own size", &|| clients() == ["100x30", "60x20"]);

        // Each resize reaches its own client; the window follows the latest.
        resize_pty(&registry, &attach, 70, 22).unwrap();
        wait_for("page 2's resize", &|| clients() == ["100x30", "70x22"]);
        if policy == "latest" {
            wait_for("the window at page 2's size", &|| {
                tmux(&["display-message", "-p", "-t", &format!("{session}:"), "#{window_width}x#{window_height}"]) == "70x22"
            });
        }
        let size = registry.lock().unwrap().entries[tab].master.get_size().unwrap();
        assert_eq!((size.cols, size.rows), (100, 30), "page 1's PTY keeps page 1's size");

        // Type through page 2: both pages see it, each from its own PTY, and
        // nothing is broadcast.
        events.take();
        let sender = registry.lock().unwrap().input_sender(&attach).unwrap();
        sender.send(b"marker2347".to_vec()).await.unwrap();
        let mut text: HashMap<Option<ClientId>, String> = HashMap::new();
        for _ in 0..200 {
            for e in events.take() {
                if e.event == "terminal-output" {
                    let v: serde_json::Value = serde_json::from_str(&e.payload).unwrap();
                    assert_eq!(v["id"], tab, "every chunk names the tab");
                    text.entry(e.client).or_default().push_str(v["data"].as_str().unwrap_or(""));
                }
            }
            let has = |c: ClientId| text.get(&Some(c)).is_some_and(|t| t.contains("marker2347"));
            if has(web(81)) && has(web(82)) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert!(!text.contains_key(&None), "no chunk is broadcast");
        for c in [web(81), web(82)] {
            assert!(text.get(&Some(c.clone())).is_some_and(|t| t.contains("marker2347")), "{c} saw the typing: {text:?}");
        }

        // Page 2 closes its view: its tmux client goes, page 1's and the
        // session stay.
        let taken = registry.lock().unwrap().take(&attach).unwrap();
        route_remove_all_views(&attach);
        teardown_taken(vec![taken]);
        wait_for("page 2's client to leave", &|| clients() == ["100x30"]);
        let alive = std::process::Command::new("tmux")
            .args(["-L", &socket, "-f", "/dev/null", "has-session", "-t", &format!("={session}")])
            .status()
            .is_ok_and(|s| s.success());
        assert!(alive, "the session outlives page 2's client");
        assert!(registry.lock().unwrap().attachable(tab, &web(82)).is_some(), "page 1's PTY lives");

        // Page 2 comes back, and page 1 goes for good: the tab PTY is handed
        // to page 2, so the session keeps both clients.
        let join = join_tab(&ctx2, &registry, &opts(60, 20), attach_argv).unwrap();
        assert!(join.attached);
        wait_for("page 2 back", &|| clients().len() == 2);
        route_drop_window_views("web-81");
        assert!(registry.lock().unwrap().release_client(&web(81)).is_empty());
        assert_eq!(registry.lock().unwrap().entries[tab].meta.client, Some(web(82)));
        wait_for("the handed-over tab PTY at page 2's size", &|| clients() == ["60x20", "60x20"]);

        // Page 2 goes too: its attach ends; the tab PTY is left to nobody —
        // the session is the server's (a clean quit or the tab's close kills
        // it, not this) and the tab's bookkeeping lives as long as it does.
        let taken = registry.lock().unwrap().release_client(&web(82));
        assert_eq!(taken.len(), 1);
        teardown_taken(taken);
        wait_for("only the tab PTY's client", &|| clients().len() == 1);
        assert_eq!(registry.lock().unwrap().entries[tab].meta.client, None);
        // A later page attaches to it, and the session's end ends it.
        let ctx3 = ctx_as(Caller::Client(web(83)), events.clone());
        let join = join_tab(&ctx3, &registry, &opts(80, 24), attach_argv).unwrap();
        assert!(join.attached, "a page opening the tab later attaches");
        wait_for("page 3 attached", &|| clients().len() == 2);
        let socket_path = tmux(&["display-message", "-p", "#{socket_path}"]);
        tmux(&["kill-server"]);
        let attach3 = attach_pty_id(tab, &web(83));
        wait_for("the session's end to reach the tab PTY", &|| {
            matches!(registry.lock().unwrap().entries.get_mut(tab).map(|e| e.child.try_wait()), Some(Ok(Some(_))))
        });
        let taken = registry.lock().unwrap().release_client(&web(83));
        let mut ids: Vec<String> = taken.iter().map(|t| t.id.clone()).collect();
        ids.sort();
        assert_eq!(ids, vec![tab.to_string(), attach3.clone()]);
        teardown_taken(taken);
        if !socket_path.is_empty() {
            let _ = std::fs::remove_file(socket_path);
        }
        route_drop_window_views("web-82");
        let mut map = routes().lock().unwrap();
        map.remove(tab);
        map.remove(&attach);
        map.remove(&attach3);
    }
}

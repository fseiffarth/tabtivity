//! One listening session: frames from an [`AudioSource`] through the voice
//! detector to a [`Transcriber`] on its own worker thread, and the events the
//! owner's window sees. Generic over both, so the owner, pause, gate and
//! stop rules are tested with fakes, without a sound card or a model.
//!
//! Threads: the capture callback (cpal's) only resamples and sends; this
//! session thread segments and emits; the worker holds whisper, one job at a
//! time, finals in order. A final that is due aborts a partial in flight
//! (whisper's abort callback), so the partial never delays it.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use app_core::CoreCtx;
use serde::{Deserialize, Serialize};

use super::vad::{Vad, VadConfig, VadEvent, RATE};
use super::{phantom, ListenRequest, Owner, VoiceError, EV_ERROR, EV_FINAL, EV_LEVEL, EV_PARTIAL, EV_STATE, EV_VAD};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ListenMode {
    /// Words into the draft; 700 ms of silence ends a segment.
    Dictate,
    /// The pause after speech sends (step 4); the pause is the setting.
    HandsFree,
}

/// The switches a session's threads share with the commands.
#[derive(Default)]
pub struct Control {
    stop: AtomicBool,
    abort: AtomicBool,
    paused: AtomicBool,
}

impl Control {
    /// Stop listening; the open segment and the queued ones are still
    /// transcribed and sent.
    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }

    /// Stop now: nothing more is transcribed or sent.
    pub fn abort(&self) {
        self.abort.store(true, Ordering::SeqCst);
        self.stop();
    }

    pub fn stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    pub fn aborted(&self) -> bool {
        self.abort.load(Ordering::SeqCst)
    }

    pub fn set_paused(&self, paused: bool) {
        self.paused.store(paused, Ordering::SeqCst);
    }

    pub fn paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }
}

/// Half-duplex with the OS voice: while it speaks, and for a tail after,
/// captured audio is thrown away so the speakers never dictate into the
/// draft. Machine-wide, like the voice; the capture callback reads it.
pub struct MuteGate {
    speaking: AtomicBool,
    /// Milliseconds after [`MuteGate::epoch`] until which the tail mutes.
    tail_until_ms: AtomicU64,
    epoch: std::sync::OnceLock<Instant>,
}

/// The tail after the voice stops (the output device's buffer; step 0's host
/// probe may raise it).
pub const MUTE_TAIL: Duration = Duration::from_millis(300);

impl MuteGate {
    pub const fn new() -> Self {
        Self { speaking: AtomicBool::new(false), tail_until_ms: AtomicU64::new(0), epoch: std::sync::OnceLock::new() }
    }

    fn ms(&self, at: Instant) -> u64 {
        at.saturating_duration_since(*self.epoch.get_or_init(Instant::now)).as_millis() as u64
    }

    /// The voice started (`true`) or stopped (`false`) at `at`.
    pub fn set_speaking(&self, speaking: bool, at: Instant) {
        if !speaking {
            self.tail_until_ms.store(self.ms(at + MUTE_TAIL), Ordering::SeqCst);
        }
        self.speaking.store(speaking, Ordering::SeqCst);
    }

    pub fn muted(&self, at: Instant) -> bool {
        self.speaking.load(Ordering::SeqCst) || self.ms(at) < self.tail_until_ms.load(Ordering::SeqCst)
    }
}

impl Default for MuteGate {
    fn default() -> Self {
        Self::new()
    }
}

pub static GATE: MuteGate = MuteGate::new();

/// What the capture sends: 16 kHz mono audio, or why it stopped. `after_gap`
/// marks audio following samples the mute gate threw away.
pub enum Frames {
    Audio { samples: Vec<f32>, after_gap: bool },
    Failed(VoiceError),
}

/// The microphone, already opened. `start` begins delivering to `sink`;
/// dropping the source closes the stream.
pub trait AudioSource: Send + 'static {
    fn start(&mut self, sink: SyncSender<Frames>) -> Result<(), VoiceError>;
}

pub struct Transcript {
    pub text: String,
    /// Whisper's no-speech probability (the highest of the segment's windows).
    pub no_speech: f32,
}

/// Speech to text, living on the worker thread (whisper's parameters are not
/// `Send`).
pub trait Transcriber {
    /// `partial`: a cheaper preview of a segment still open. A run gives up
    /// when the factory's `cancel` flag turns true (a final is due, or the
    /// session aborts); a cancelled run's result is thrown away.
    fn transcribe(&mut self, audio: &[f32], partial: bool) -> Result<Transcript, VoiceError>;

    /// Whether a finished segment is speech at all (Silero, when installed).
    fn confirm_speech(&mut self, _audio: &[f32]) -> bool {
        true
    }
}

/// Builds the session's [`Transcriber`] on the worker thread.
pub trait TranscriberFactory: Send + 'static {
    type T: Transcriber;
    /// `cancel` is the flag the transcriber's runs must give up on.
    fn load(self, config: &SessionConfig, cancel: Arc<AtomicBool>) -> Result<Self::T, VoiceError>;
}

/// A session's settings, checked by [`ListenRequest::validate`].
#[derive(Clone, Debug)]
pub struct SessionConfig {
    pub session: u64,
    pub owner: Owner,
    pub mode: ListenMode,
    pub lang: String,
    pub end_silence_ms: u32,
    pub headset: bool,
    pub prompt: Option<String>,
}

impl SessionConfig {
    pub fn from_request(session: u64, owner: Owner, req: &ListenRequest) -> Self {
        Self {
            session,
            owner,
            mode: req.mode,
            lang: req.lang.clone(),
            end_silence_ms: req.pause_ms,
            headset: req.headset,
            prompt: req.prompt.clone(),
        }
    }
}

// ── Event payloads ────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LevelEvent {
    session: u64,
    /// 0–1 on the phone meter's scale (RMS × 4).
    level: f32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VadEventPayload {
    session: u64,
    segment: u64,
    state: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TextEvent<'a> {
    session: u64,
    segment: u64,
    /// Empty in a final: the segment was dropped (a phantom, or no speech).
    text: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StateEvent {
    session: u64,
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<VoiceError>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorEvent {
    session: u64,
    code: VoiceError,
}

// ── The session thread ────────────────────────────────────────────────────

/// Partials while a segment is open: this often, over this much audio.
const PARTIAL_EVERY: Duration = Duration::from_millis(1000);
const PARTIAL_TAIL_SAMPLES: usize = 5 * RATE as usize;
/// `voice:level` at most this often (≤ 20 Hz).
const LEVEL_EVERY: Duration = Duration::from_millis(50);
/// A mic muted in the OS (or on its cable) still opens and delivers digital
/// silence: this long with every sample below one 16-bit step is "muted".
const SILENT_AFTER_SAMPLES: usize = 3 * RATE as usize;
const SILENT_PEAK: f32 = 1e-5;
/// After a stop, how long the queued finals may take.
const DRAIN_LIMIT: Duration = Duration::from_secs(30);

enum Job {
    Partial { segment: u64, audio: Vec<f32> },
    Final { segment: u64, audio: Vec<f32> },
}

enum Done {
    Loaded(Result<(), VoiceError>),
    Partial { segment: u64, outcome: Result<Transcript, VoiceError> },
    Final { segment: u64, outcome: Result<Transcript, VoiceError> },
}

fn worker<F: TranscriberFactory>(
    factory: F,
    config: SessionConfig,
    cancel: Arc<AtomicBool>,
    jobs: Receiver<Job>,
    done: Sender<Done>,
) {
    let mut transcriber = match factory.load(&config, cancel.clone()) {
        Ok(t) => {
            let _ = done.send(Done::Loaded(Ok(())));
            t
        }
        Err(e) => {
            let _ = done.send(Done::Loaded(Err(e)));
            return;
        }
    };
    while let Ok(job) = jobs.recv() {
        match job {
            Job::Final { segment, audio } => {
                cancel.store(false, Ordering::SeqCst);
                let outcome = if transcriber.confirm_speech(&audio) {
                    transcriber.transcribe(&audio, false)
                } else {
                    Ok(Transcript { text: String::new(), no_speech: 1.0 })
                };
                if done.send(Done::Final { segment, outcome }).is_err() {
                    return;
                }
            }
            // A final queued behind this partial already cancelled it.
            Job::Partial { .. } if cancel.load(Ordering::SeqCst) => {}
            Job::Partial { segment, audio } => {
                let outcome = transcriber.transcribe(&audio, true);
                if done.send(Done::Partial { segment, outcome }).is_err() {
                    return;
                }
            }
        }
    }
}

struct Listener {
    ctx: CoreCtx,
    config: SessionConfig,
    control: Arc<Control>,
    cancel: Arc<AtomicBool>,
    jobs: Sender<Job>,
    vad: Vad,
    segment: u64,
    /// Finals queued and not yet answered.
    pending_finals: usize,
    partial_running: bool,
    last_partial: Instant,
    level_sum: f32,
    level_n: usize,
    last_level: Instant,
    was_paused: bool,
    /// Samples in a row at digital silence, and whether the user was told.
    silent: usize,
    silent_told: bool,
}

impl Listener {
    fn to_owner<S: Serialize>(&self, event: &str, payload: S) {
        self.ctx.emit_to(self.config.owner.client(), event, payload);
    }

    fn state(&self, state: &'static str, reason: Option<VoiceError>) {
        self.ctx.emit(EV_STATE, StateEvent { session: self.config.session, state, reason });
    }

    fn queue_final(&mut self, audio: Vec<f32>) {
        self.to_owner(EV_VAD, VadEventPayload { session: self.config.session, segment: self.segment, state: "end" });
        // Cancel a partial in flight: the final must not wait for it.
        self.cancel.store(true, Ordering::SeqCst);
        if self.jobs.send(Job::Final { segment: self.segment, audio }).is_ok() {
            self.pending_finals += 1;
        }
    }

    /// Warns once when the mic has delivered only silence for a while, and
    /// says `listening` again when sound returns, which clears the warning.
    fn watch_silence(&mut self, samples: &[f32]) {
        if samples.iter().all(|s| s.abs() <= SILENT_PEAK) {
            self.silent += samples.len();
            if self.silent >= SILENT_AFTER_SAMPLES && !self.silent_told {
                self.silent_told = true;
                self.to_owner(EV_ERROR, ErrorEvent { session: self.config.session, code: VoiceError::MicSilent });
            }
        } else {
            self.silent = 0;
            if self.silent_told {
                self.silent_told = false;
                self.state("listening", None);
            }
        }
    }

    fn audio(&mut self, samples: &[f32], after_gap: bool) {
        if self.control.paused() {
            if !self.was_paused {
                self.was_paused = true;
                // An open segment is dropped, not sent: pausing means "not now".
                self.vad.reset();
                self.state("paused", None);
            }
            return;
        }
        if self.was_paused {
            self.was_paused = false;
            self.silent = 0;
            self.state("listening", None);
        }
        self.watch_silence(samples);
        if after_gap {
            // The voice spoke over part of it: what was said before goes in.
            if let Some(audio) = self.vad.flush() {
                self.queue_final(audio);
            }
            self.vad.reset();
        }
        self.level_sum += samples.iter().map(|s| s * s).sum::<f32>();
        self.level_n += samples.len();
        if self.last_level.elapsed() >= LEVEL_EVERY && self.level_n > 0 {
            let rms = (self.level_sum / self.level_n as f32).sqrt();
            self.to_owner(EV_LEVEL, LevelEvent { session: self.config.session, level: (rms * 4.0).min(1.0) });
            self.level_sum = 0.0;
            self.level_n = 0;
            self.last_level = Instant::now();
        }
        for event in self.vad.push(samples) {
            match event {
                VadEvent::Start => {
                    self.segment += 1;
                    self.last_partial = Instant::now();
                    self.to_owner(
                        EV_VAD,
                        VadEventPayload { session: self.config.session, segment: self.segment, state: "start" },
                    );
                }
                VadEvent::End(audio) => self.queue_final(audio),
            }
        }
        if !self.partial_running && self.last_partial.elapsed() >= PARTIAL_EVERY {
            if let Some(open) = self.vad.open_audio() {
                let tail = open[open.len().saturating_sub(PARTIAL_TAIL_SAMPLES)..].to_vec();
                if self.jobs.send(Job::Partial { segment: self.segment, audio: tail }).is_ok() {
                    self.partial_running = true;
                }
                self.last_partial = Instant::now();
            }
        }
    }

    fn done(&mut self, done: Done) {
        let session = self.config.session;
        match done {
            Done::Loaded(_) => {}
            Done::Partial { segment, outcome } => {
                self.partial_running = false;
                // Only while that segment is still the open one.
                if segment != self.segment || !self.vad.is_open() || self.cancel.load(Ordering::SeqCst) {
                    return;
                }
                if let Ok(t) = outcome {
                    if let Some(text) = phantom::keep(&t.text, t.no_speech, self.config.prompt.as_deref()) {
                        self.to_owner(EV_PARTIAL, TextEvent { session, segment, text: &text });
                    }
                }
            }
            Done::Final { segment, outcome } => {
                self.pending_finals = self.pending_finals.saturating_sub(1);
                let text = match outcome {
                    Ok(t) => phantom::keep(&t.text, t.no_speech, self.config.prompt.as_deref()),
                    Err(e) => {
                        if !self.control.aborted() {
                            self.to_owner(EV_ERROR, ErrorEvent { session, code: e });
                        }
                        None
                    }
                };
                // Always a final, empty when dropped: the renderer then knows
                // the segment has settled.
                self.to_owner(EV_FINAL, TextEvent { session, segment, text: text.as_deref().unwrap_or("") });
            }
        }
    }
}

/// The session thread. Returns when the session stopped and its queued
/// finals were answered (or it was aborted).
pub fn run<S: AudioSource, F: TranscriberFactory>(
    ctx: CoreCtx,
    config: SessionConfig,
    control: Arc<Control>,
    mut source: S,
    factory: F,
) {
    let session = config.session;
    let cancel = Arc::new(AtomicBool::new(false));
    let (jobs_tx, jobs_rx) = mpsc::channel();
    let (done_tx, done_rx) = mpsc::channel();
    let mut listener = Listener {
        ctx: ctx.clone(),
        vad: Vad::new(VadConfig::new(config.end_silence_ms)),
        config: config.clone(),
        control: control.clone(),
        cancel: cancel.clone(),
        jobs: jobs_tx,
        segment: 0,
        pending_finals: 0,
        partial_running: false,
        last_partial: Instant::now(),
        level_sum: 0.0,
        level_n: 0,
        last_level: Instant::now(),
        was_paused: false,
        silent: 0,
        silent_told: false,
    };
    listener.state("preparing", None);

    // The abort switch reaches whisper through `cancel`, checked between its
    // encoder and decoder steps.
    let worker_cancel = cancel.clone();
    let spawned = std::thread::Builder::new()
        .name(format!("voice-stt-{session}"))
        .spawn(move || worker(factory, config, worker_cancel, jobs_rx, done_tx));
    if spawned.is_err() {
        listener.state("stopped", Some(VoiceError::ModelFailed));
        return;
    }
    let loaded = loop {
        if control.aborted() {
            cancel.store(true, Ordering::SeqCst);
            listener.state("stopped", None);
            return;
        }
        match done_rx.recv_timeout(Duration::from_millis(50)) {
            Ok(Done::Loaded(result)) => break result,
            Ok(_) => {}
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break Err(VoiceError::ModelFailed),
        }
    };
    if let Err(e) = loaded {
        listener.to_owner(EV_ERROR, ErrorEvent { session, code: e });
        listener.state("stopped", Some(e));
        return;
    }

    let (frames_tx, frames_rx) = mpsc::sync_channel(64);
    if let Err(e) = source.start(frames_tx) {
        listener.to_owner(EV_ERROR, ErrorEvent { session, code: e });
        listener.state("stopped", Some(e));
        return;
    }
    if control.paused() {
        listener.was_paused = true;
        listener.state("paused", None);
    } else {
        listener.state("listening", None);
    }

    let mut reason = None;
    while !control.stopped() {
        match frames_rx.recv_timeout(Duration::from_millis(50)) {
            Ok(Frames::Audio { samples, after_gap }) => listener.audio(&samples, after_gap),
            Ok(Frames::Failed(e)) => {
                listener.to_owner(EV_ERROR, ErrorEvent { session, code: e });
                reason = Some(e);
                break;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                reason = Some(VoiceError::DeviceFailed);
                break;
            }
        }
        while let Ok(done) = done_rx.try_recv() {
            listener.done(done);
        }
    }
    drop(source);

    if control.aborted() {
        cancel.store(true, Ordering::SeqCst);
    } else {
        // What was said before the stop still goes into the draft.
        if !control.paused() {
            if let Some(audio) = listener.vad.flush() {
                listener.queue_final(audio);
            }
        }
        let deadline = Instant::now() + DRAIN_LIMIT;
        while listener.pending_finals > 0 && !control.aborted() && Instant::now() < deadline {
            match done_rx.recv_timeout(Duration::from_millis(50)) {
                Ok(done) => listener.done(done),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
        if control.aborted() {
            cancel.store(true, Ordering::SeqCst);
        }
    }
    listener.state("stopped", reason);
}

#[cfg(test)]
mod tests {
    use super::super::vad::tests::{hiss, tone};
    use super::*;
    use app_core::{Caller, ClientId, CoreState, RecordingEvents};
    use std::sync::Mutex;

    fn ctx(events: Arc<RecordingEvents>) -> CoreCtx {
        CoreCtx::new(Arc::new(CoreState::new()), events, Caller::System)
    }

    fn config(session: u64) -> SessionConfig {
        SessionConfig {
            session,
            owner: Owner::Tab { client: ClientId::new("main"), key: "tab-1".into() },
            mode: ListenMode::Dictate,
            lang: "en".into(),
            end_silence_ms: 700,
            headset: false,
            prompt: None,
        }
    }

    /// Plays `audio` in 10 ms pieces, then keeps the stream open silently.
    struct FakeSource {
        audio: Vec<f32>,
        gap_at: Option<usize>,
        fail_start: Option<VoiceError>,
    }

    impl AudioSource for FakeSource {
        fn start(&mut self, sink: SyncSender<Frames>) -> Result<(), VoiceError> {
            if let Some(e) = self.fail_start {
                return Err(e);
            }
            let audio = std::mem::take(&mut self.audio);
            let gap_at = self.gap_at;
            std::thread::spawn(move || {
                for (i, piece) in audio.chunks(160).enumerate() {
                    let after_gap = gap_at == Some(i);
                    if sink.send(Frames::Audio { samples: piece.to_vec(), after_gap }).is_err() {
                        return;
                    }
                }
                // Hold the stream open with silence until the session drops it.
                while sink.send(Frames::Audio { samples: vec![0.0; 160], after_gap: false }).is_ok() {
                    std::thread::sleep(Duration::from_millis(5));
                }
            });
            Ok(())
        }
    }

    /// Each run's audio length and whether it was a partial.
    type Calls = Arc<Mutex<Vec<(usize, bool)>>>;

    /// Answers each run with its text and the run's number, counting runs.
    struct FakeFactory {
        fail: Option<VoiceError>,
        calls: Calls,
        text: &'static str,
    }

    struct FakeTranscriber {
        calls: Calls,
        text: &'static str,
    }

    impl Transcriber for FakeTranscriber {
        fn transcribe(&mut self, audio: &[f32], partial: bool) -> Result<Transcript, VoiceError> {
            let mut calls = self.calls.lock().unwrap();
            calls.push((audio.len(), partial));
            // A tag is whisper's whole answer; words get the call's number.
            let text = if self.text.starts_with('[') { self.text.to_string() } else { format!("{} {}", self.text, calls.len()) };
            Ok(Transcript { text, no_speech: 0.0 })
        }
    }

    impl TranscriberFactory for FakeFactory {
        type T = FakeTranscriber;
        fn load(self, _config: &SessionConfig, _cancel: Arc<AtomicBool>) -> Result<FakeTranscriber, VoiceError> {
            match self.fail {
                Some(e) => Err(e),
                None => Ok(FakeTranscriber { calls: self.calls, text: self.text }),
            }
        }
    }

    fn factory() -> (FakeFactory, Calls) {
        let calls = Arc::new(Mutex::new(Vec::new()));
        (FakeFactory { fail: None, calls: calls.clone(), text: "words" }, calls)
    }

    fn speech() -> Vec<f32> {
        let mut audio = hiss(500);
        audio.extend(tone(800, 220.0, 0.2));
        audio.extend(hiss(1000));
        audio
    }

    fn wait_for(events: &RecordingEvents, event: &str, n: usize) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while events.payloads(event).len() < n {
            assert!(Instant::now() < deadline, "timed out waiting for {n} × {event}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn spawn<S: AudioSource, F: TranscriberFactory>(
        events: &Arc<RecordingEvents>,
        cfg: SessionConfig,
        source: S,
        factory: F,
    ) -> (Arc<Control>, std::thread::JoinHandle<()>) {
        let control = Arc::new(Control::default());
        let ctx = ctx(events.clone());
        let c = control.clone();
        (control, std::thread::spawn(move || run(ctx, cfg, c, source, factory)))
    }

    #[test]
    fn speech_becomes_one_final_for_the_owner_only() {
        let events = RecordingEvents::new();
        let (factory, _) = factory();
        let (control, thread) = spawn(&events, config(7), FakeSource { audio: speech(), gap_at: None, fail_start: None }, factory);
        wait_for(&events, EV_FINAL, 1);
        control.stop();
        thread.join().unwrap();
        let all = events.take();
        let finals: Vec<_> = all.iter().filter(|e| e.event == EV_FINAL).collect();
        assert_eq!(finals.len(), 1);
        assert_eq!(finals[0].client.as_ref().map(ClientId::as_str), Some("main"));
        let payload: serde_json::Value = serde_json::from_str(&finals[0].payload).unwrap();
        assert_eq!(payload, serde_json::json!({ "session": 7, "segment": 1, "text": "words 1" }));
        let vad: Vec<serde_json::Value> =
            all.iter().filter(|e| e.event == EV_VAD).map(|e| serde_json::from_str(&e.payload).unwrap()).collect();
        assert_eq!(vad[0]["state"], "start");
        assert_eq!(vad[1]["state"], "end");
        assert!(all.iter().filter(|e| e.event == EV_LEVEL).all(|e| e.client.is_some()));
        let states: Vec<String> = all
            .iter()
            .filter(|e| e.event == EV_STATE)
            .map(|e| {
                assert!(e.client.is_none(), "state is broadcast");
                serde_json::from_str::<serde_json::Value>(&e.payload).unwrap()["state"].as_str().unwrap().to_string()
            })
            .collect();
        assert_eq!(states, ["preparing", "listening", "stopped"]);
    }

    #[test]
    fn stopping_mid_sentence_still_transcribes_it() {
        let events = RecordingEvents::new();
        let (factory, calls) = factory();
        let mut audio = hiss(500);
        audio.extend(tone(600, 220.0, 0.2));
        let (control, thread) = spawn(&events, config(1), FakeSource { audio, gap_at: None, fail_start: None }, factory);
        wait_for(&events, EV_VAD, 1);
        // Let the rest of the tone reach the detector.
        std::thread::sleep(Duration::from_millis(200));
        control.stop();
        thread.join().unwrap();
        assert_eq!(events.payloads(EV_FINAL).len(), 1);
        assert!(calls.lock().unwrap().iter().any(|(_, partial)| !partial));
    }

    #[test]
    fn an_abort_sends_nothing_more() {
        let events = RecordingEvents::new();
        let (factory, _) = factory();
        let mut audio = hiss(500);
        audio.extend(tone(600, 220.0, 0.2));
        let (control, thread) = spawn(&events, config(1), FakeSource { audio, gap_at: None, fail_start: None }, factory);
        wait_for(&events, EV_VAD, 1);
        control.abort();
        thread.join().unwrap();
        assert!(events.payloads(EV_FINAL).is_empty());
        assert_eq!(events.payloads(EV_STATE).last().unwrap()["state"], "stopped");
    }

    #[test]
    fn a_paused_session_hears_nothing() {
        let events = RecordingEvents::new();
        let (factory, calls) = factory();
        let control = Arc::new(Control::default());
        control.set_paused(true);
        let (ctx, c) = (ctx(events.clone()), control.clone());
        let source = FakeSource { audio: speech(), gap_at: None, fail_start: None };
        let thread = std::thread::spawn(move || run(ctx, config(1), c, source, factory));
        wait_for(&events, EV_STATE, 2);
        std::thread::sleep(Duration::from_millis(300));
        control.stop();
        thread.join().unwrap();
        assert!(calls.lock().unwrap().is_empty());
        assert!(events.payloads(EV_VAD).is_empty());
        let states: Vec<_> = events.payloads(EV_STATE).iter().map(|s| s["state"].clone()).collect();
        assert_eq!(states, ["preparing", "paused", "stopped"]);
    }

    #[test]
    fn a_muted_mic_is_warned_about_once_and_keeps_listening() {
        let events = RecordingEvents::new();
        let (factory, _) = factory();
        let source = FakeSource { audio: vec![0.0; 4 * RATE as usize], gap_at: None, fail_start: None };
        let (control, thread) = spawn(&events, config(3), source, factory);
        wait_for(&events, EV_ERROR, 1);
        std::thread::sleep(Duration::from_millis(200));
        control.stop();
        thread.join().unwrap();
        let errors = events.payloads(EV_ERROR);
        assert_eq!(errors, [serde_json::json!({ "session": 3, "code": "mic-silent" })]);
        let states: Vec<_> = events.payloads(EV_STATE).iter().map(|s| s["state"].clone()).collect();
        assert_eq!(states, ["preparing", "listening", "stopped"]);
        assert!(events.payloads(EV_STATE).last().unwrap().get("reason").is_none());
    }

    #[test]
    fn sound_after_the_warning_says_listening_again() {
        let events = RecordingEvents::new();
        let (factory, _) = factory();
        let mut audio = vec![0.0; 3 * RATE as usize + 1600];
        audio.extend(tone(300, 220.0, 0.2));
        let (control, thread) = spawn(&events, config(3), FakeSource { audio, gap_at: None, fail_start: None }, factory);
        wait_for(&events, EV_STATE, 3);
        control.stop();
        thread.join().unwrap();
        assert_eq!(events.payloads(EV_ERROR).len(), 1);
        let states: Vec<_> = events.payloads(EV_STATE).iter().map(|s| s["state"].clone()).collect();
        assert_eq!(states[..3], ["preparing", "listening", "listening"]);
    }

    #[test]
    fn audio_after_the_voice_spoke_ends_the_open_segment() {
        let events = RecordingEvents::new();
        let (factory, _) = factory();
        let mut audio = hiss(500);
        audio.extend(tone(600, 220.0, 0.2));
        // The gate threw samples away here; then more speech.
        let gap = audio.len() / 160;
        audio.extend(tone(600, 220.0, 0.2));
        audio.extend(hiss(1000));
        let (control, thread) = spawn(&events, config(1), FakeSource { audio, gap_at: Some(gap), fail_start: None }, factory);
        wait_for(&events, EV_FINAL, 2);
        control.stop();
        thread.join().unwrap();
        let segments: Vec<_> = events.payloads(EV_FINAL).iter().map(|f| f["segment"].clone()).collect();
        assert_eq!(segments, [1, 2]);
    }

    #[test]
    fn a_model_that_will_not_load_stops_the_session() {
        let events = RecordingEvents::new();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let factory = FakeFactory { fail: Some(VoiceError::ModelFailed), calls, text: "" };
        let (_control, thread) = spawn(&events, config(3), FakeSource { audio: speech(), gap_at: None, fail_start: None }, factory);
        thread.join().unwrap();
        assert_eq!(events.payloads(EV_ERROR), [serde_json::json!({ "session": 3, "code": "model-failed" })]);
        assert_eq!(
            events.payloads(EV_STATE).last().unwrap(),
            &serde_json::json!({ "session": 3, "state": "stopped", "reason": "model-failed" })
        );
    }

    #[test]
    fn a_phantom_final_is_sent_empty() {
        let events = RecordingEvents::new();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let factory = FakeFactory { fail: None, calls, text: "[BLANK_AUDIO]" };
        let (control, thread) = spawn(&events, config(1), FakeSource { audio: speech(), gap_at: None, fail_start: None }, factory);
        wait_for(&events, EV_FINAL, 1);
        control.stop();
        thread.join().unwrap();
        assert_eq!(events.payloads(EV_FINAL)[0]["text"], "");
    }

    #[test]
    fn the_gate_mutes_while_speaking_and_for_the_tail() {
        let gate = MuteGate::new();
        let t0 = Instant::now();
        assert!(!gate.muted(t0));
        gate.set_speaking(true, t0);
        assert!(gate.muted(t0 + Duration::from_secs(5)));
        let end = t0 + Duration::from_secs(6);
        gate.set_speaking(false, end);
        assert!(gate.muted(end + Duration::from_millis(250)));
        assert!(!gate.muted(end + MUTE_TAIL + Duration::from_millis(10)));
    }
}

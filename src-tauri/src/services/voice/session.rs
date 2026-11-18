//! One listening session: frames from an [`AudioSource`] through the voice
//! detector to a [`Transcriber`] on its own worker thread, and the events the
//! owner's window sees. Generic over both, so the owner, pause, gate and
//! stop rules are tested with fakes, without a sound card or a model.
//!
//! Threads: the capture callback (cpal's) only resamples and sends; this
//! session thread segments and emits; the worker holds whisper, one job at a
//! time, finals in order. A final that is due aborts a partial in flight
//! (whisper's abort callback), so the partial never delays it.
//!
//! Partials (`voice:partial`) are the renderer's provisional text, written
//! straight into the input field, so each one is the transcript of the WHOLE
//! open segment so far, never a tail. While the segment is short that is one
//! run over all of it. A long one would cost more with every partial, so the
//! text before a seam (a [`vad::SEAM_SILENCE_MS`] pause the detector heard
//! inside the segment) is committed once and kept: later partials run only
//! on the audio after the seam and emit `committed + tail`. Cadence is
//! adaptive ([`Pacing`]): the first partial as soon as there is speech, the
//! next one a small gap after the previous finished. The final is always one
//! run over the whole segment (a seam is not a sentence end; a final split
//! there would punctuate mid-sentence), and replaces whatever the partials said.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use app_core::CoreCtx;
use serde::{Deserialize, Serialize};

use super::gpu::VoiceDevice;
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
///
/// Headset mode (a setting, off by default) opens the gate: the voice is in
/// the user's ears, not in the mic, so speech heard while it speaks is the
/// user talking over it — barge-in, which stops the voice
/// ([`SessionConfig::barge_in`]).
pub struct MuteGate {
    speaking: AtomicBool,
    /// Milliseconds after [`MuteGate::epoch`] until which the tail mutes.
    tail_until_ms: AtomicU64,
    epoch: std::sync::OnceLock<Instant>,
    /// The listening session in headset mode, 0 for none: only that session
    /// may close the gate again, so an old session ending late cannot undo
    /// the new one's mode.
    headset_session: AtomicU64,
}

/// The tail after the voice stops (the output device's buffer; step 0's host
/// probe may raise it).
pub const MUTE_TAIL: Duration = Duration::from_millis(300);

/// How long a segment that began while the voice spoke (Headset mode) must
/// have gone on after it opened — the voice is stopped at once, so its echo
/// dies within [`MUTE_TAIL`] — to count as the user talking over it. Shorter,
/// it is the voice's own words (an agent's text, attacker-influenced, heard
/// back on speakers: a lone "One.") and is dropped, not transcribed.
pub const BARGE_IN_MIN_MS: usize = 600;

impl MuteGate {
    pub const fn new() -> Self {
        Self {
            speaking: AtomicBool::new(false),
            tail_until_ms: AtomicU64::new(0),
            epoch: std::sync::OnceLock::new(),
            headset_session: AtomicU64::new(0),
        }
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

    /// Whether the voice is speaking now (the tail aside).
    pub fn speaking(&self) -> bool {
        self.speaking.load(Ordering::SeqCst)
    }

    /// Session `session` listens in headset mode (`on`), or has stopped
    /// (`off`; a no-op unless it is the session that turned it on).
    pub fn set_headset(&self, session: u64, on: bool) {
        if on {
            self.headset_session.store(session, Ordering::SeqCst);
        } else {
            let _ = self.headset_session.compare_exchange(session, 0, Ordering::SeqCst, Ordering::SeqCst);
        }
    }

    pub fn muted(&self, at: Instant) -> bool {
        if self.headset_session.load(Ordering::SeqCst) != 0 {
            return false;
        }
        self.speaking.load(Ordering::SeqCst) || self.ms(at) < self.tail_until_ms.load(Ordering::SeqCst)
    }
}

impl Default for MuteGate {
    fn default() -> Self {
        Self::new()
    }
}

pub static GATE: MuteGate = MuteGate::new();

/// Tests that set or read [`GATE`] (here and in `tts`) take turns with it.
#[cfg(test)]
pub(super) static GATE_SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

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

    /// The device this transcriber landed on, when it has one to report.
    fn device(&self) -> Option<VoiceDevice> {
        None
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
    /// Stops the voice when speech starts while it speaks, in headset mode
    /// ([`super::tts::stop`]; a fake in tests). It stops the voice, never the
    /// agent's turn.
    pub barge_in: fn(),
    pub pacing: Pacing,
}

/// How often and over how much the live preview runs.
#[derive(Clone, Copy, Debug)]
pub struct Pacing {
    /// The next partial starts this long after the previous one finished,
    /// or half its run time if that is longer, up to `max_gap`: a GPU that
    /// answers in 100 ms is asked again after `min_gap`, a CPU that needs a
    /// second or two is left breathing.
    pub min_gap: Duration,
    pub max_gap: Duration,
    /// Audio after the committed text that makes the next seam worth
    /// committing (samples).
    pub commit_tail: usize,
}

impl Pacing {
    pub const LIVE: Self = Self {
        min_gap: Duration::from_millis(300),
        max_gap: Duration::from_millis(700),
        // A run over this much audio takes about 1.5 s on the CPU's `small`
        // model, about 0.2 s on a GPU (docs/voice_gpu_plan.md).
        commit_tail: 6 * RATE as usize,
    };

    fn gap_after(&self, took: Duration) -> Duration {
        (took / 2).clamp(self.min_gap, self.max_gap.max(self.min_gap))
    }
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
            barge_in: super::tts::stop,
            pacing: Pacing::LIVE,
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
    /// Where whisper runs, from the first state after the load on.
    #[serde(skip_serializing_if = "Option::is_none")]
    device: Option<VoiceDevice>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorEvent {
    session: u64,
    code: VoiceError,
}

// ── The session thread ────────────────────────────────────────────────────

/// The first partial of a segment waits for this much speech in it (the
/// segment opens with about 460 ms, so in practice at once)…
const FIRST_PARTIAL_SAMPLES: usize = 400 * RATE as usize / 1000;
/// …and a later one for this much new speech since the last.
const MIN_NEW_SPEECH_SAMPLES: usize = 100 * RATE as usize / 1000;
/// A seam is committed only with this much audio after it (not a pause that
/// is about to end the segment).
const COMMIT_MIN_AFTER_SAMPLES: usize = RATE as usize / 2;
/// `voice:level` at most this often (≤ 20 Hz).
const LEVEL_EVERY: Duration = Duration::from_millis(50);
/// A mic muted in the OS (or on its cable) still opens and delivers digital
/// silence: this long with every sample below one 16-bit step is "muted".
const SILENT_AFTER_SAMPLES: usize = 3 * RATE as usize;
const SILENT_PEAK: f32 = 1e-5;
/// After a stop, how long the queued finals may take.
const DRAIN_LIMIT: Duration = Duration::from_secs(30);

enum Job {
    /// `prefix`: audio up to a seam (and its end offset in the segment) to
    /// transcribe and commit first; `audio` is what follows.
    Partial { segment: u64, prefix: Option<(usize, Vec<f32>)>, audio: Vec<f32> },
    /// `echo`: the voice's own words heard back; answered empty, not transcribed.
    Final { segment: u64, audio: Vec<f32>, echo: bool },
}

enum Done {
    Loaded(Result<Option<VoiceDevice>, VoiceError>),
    Partial { segment: u64, prefix: Option<(usize, Result<Transcript, VoiceError>)>, outcome: Result<Transcript, VoiceError> },
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
            let _ = done.send(Done::Loaded(Ok(t.device())));
            t
        }
        Err(e) => {
            let _ = done.send(Done::Loaded(Err(e)));
            return;
        }
    };
    while let Ok(job) = jobs.recv() {
        match job {
            Job::Final { segment, audio, echo } => {
                cancel.store(false, Ordering::SeqCst);
                let outcome = if !echo && transcriber.confirm_speech(&audio) {
                    transcriber.transcribe(&audio, false)
                } else {
                    Ok(Transcript { text: String::new(), no_speech: 1.0 })
                };
                if done.send(Done::Final { segment, outcome }).is_err() {
                    return;
                }
            }
            // A final queued behind this partial already cancelled it. Still
            // answered, or the session would wait for it for ever.
            Job::Partial { segment, .. } if cancel.load(Ordering::SeqCst) => {
                if done.send(Done::Partial { segment, prefix: None, outcome: Err(VoiceError::ModelFailed) }).is_err() {
                    return;
                }
            }
            Job::Partial { segment, prefix, audio } => {
                // The seam's text is a keeper, so it gets the final's care
                // (temperature fallback); the tail is the cheap preview.
                let prefix = prefix.map(|(end, audio)| (end, transcriber.transcribe(&audio, false)));
                let outcome = transcriber.transcribe(&audio, true);
                if done.send(Done::Partial { segment, prefix, outcome }).is_err() {
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
    device: Option<VoiceDevice>,
    segment: u64,
    /// Finals queued and not yet answered.
    pending_finals: usize,
    partial_running: bool,
    partial_started: Instant,
    /// No partial before this, and none while one runs.
    next_partial: Instant,
    /// Speech in the open segment when the last partial was sent.
    partial_speech: usize,
    /// The open segment's text before its last committed seam, and the
    /// seam's offset into the segment's audio (see the module comment).
    committed_text: String,
    committed_samples: usize,
    level_sum: f32,
    level_n: usize,
    last_level: Instant,
    was_paused: bool,
    /// Samples in a row at digital silence, and whether the user was told.
    silent: usize,
    silent_told: bool,
    /// Samples taken in since the open segment began while the voice spoke
    /// in Headset mode (`None` for any other segment): see [`BARGE_IN_MIN_MS`].
    over_voice: Option<usize>,
}

impl Listener {
    fn to_owner<S: Serialize>(&self, event: &str, payload: S) {
        self.ctx.emit_to(self.config.owner.client(), event, payload);
    }

    fn state(&self, state: &'static str, reason: Option<VoiceError>) {
        let device = self.device.clone();
        self.ctx.emit(EV_STATE, StateEvent { session: self.config.session, state, reason, device });
    }

    fn queue_final(&mut self, audio: Vec<f32>) {
        self.to_owner(EV_VAD, VadEventPayload { session: self.config.session, segment: self.segment, state: "end" });
        // Cancel a partial in flight: the final must not wait for it.
        self.cancel.store(true, Ordering::SeqCst);
        // A segment that began over the voice and ended with it was the
        // voice's own echo, not a barge-in: Headset mode drops it (gap 80).
        let echo = self.over_voice.take().is_some_and(|taken| {
            let silence = (self.config.end_silence_ms as usize).div_ceil(20) * (RATE as usize / 50);
            taken.saturating_sub(silence) < BARGE_IN_MIN_MS * RATE as usize / 1000
        });
        if self.jobs.send(Job::Final { segment: self.segment, audio, echo }).is_ok() {
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
                self.over_voice = None;
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
            self.over_voice = None;
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
                    // Talking over the voice, with a headset: it stops.
                    if self.config.headset && GATE.speaking() {
                        (self.config.barge_in)();
                        self.over_voice = Some(0);
                    }
                    self.segment += 1;
                    // The first partial is due at once.
                    self.next_partial = Instant::now();
                    self.partial_speech = 0;
                    self.committed_text.clear();
                    self.committed_samples = 0;
                    self.to_owner(
                        EV_VAD,
                        VadEventPayload { session: self.config.session, segment: self.segment, state: "start" },
                    );
                }
                VadEvent::End(audio) => self.queue_final(audio),
            }
        }
        if let Some(taken) = self.over_voice.as_mut() {
            *taken += samples.len();
        }
        self.maybe_partial();
    }

    /// Starts the next preview run when one is due: none in flight, the gap
    /// passed, and speech that the last one did not hear.
    fn maybe_partial(&mut self) {
        if self.partial_running || Instant::now() < self.next_partial {
            return;
        }
        let Some(open) = self.vad.open_audio() else { return };
        let speech = open.len().saturating_sub(self.vad.trailing_silence());
        let heard = if self.partial_speech == 0 { FIRST_PARTIAL_SAMPLES } else { self.partial_speech + MIN_NEW_SPEECH_SAMPLES };
        if speech < heard {
            return;
        }
        let from = self.committed_samples.min(open.len());
        // The seam to commit: the latest one that leaves some audio after it,
        // once the uncommitted part has grown past `commit_tail`.
        let seam = (open.len() - from >= self.config.pacing.commit_tail)
            .then(|| {
                self.vad
                    .pause_marks()
                    .iter()
                    .rev()
                    .copied()
                    .find(|&m| m > from && m + COMMIT_MIN_AFTER_SAMPLES <= open.len())
            })
            .flatten();
        let job = match seam {
            Some(m) => Job::Partial { segment: self.segment, prefix: Some((m, open[from..m].to_vec())), audio: open[m..].to_vec() },
            None => Job::Partial { segment: self.segment, prefix: None, audio: open[from..].to_vec() },
        };
        if self.jobs.send(job).is_ok() {
            self.partial_running = true;
            self.partial_started = Instant::now();
            self.partial_speech = speech;
        }
    }

    fn done(&mut self, done: Done) {
        let session = self.config.session;
        match done {
            Done::Loaded(_) => {}
            Done::Partial { segment, prefix, outcome } => {
                self.partial_running = false;
                let gap = self.config.pacing.gap_after(self.partial_started.elapsed());
                self.next_partial = Instant::now() + gap;
                // Only while that segment is still the open one.
                if segment != self.segment || !self.vad.is_open() || self.cancel.load(Ordering::SeqCst) {
                    return;
                }
                let prompt = self.config.prompt.as_deref();
                let mut committed = None;
                if let Some((end, run)) = prefix {
                    // A seam that failed is tried again by the next partial;
                    // this one says nothing rather than drop the words before it.
                    let Ok(t) = run else { return };
                    let piece = phantom::keep(&t.text, t.no_speech, prompt);
                    committed = Some((end, join(&self.committed_text, piece.as_deref())));
                }
                let Ok(t) = outcome else { return };
                if let Some((end, text)) = committed {
                    self.committed_samples = end;
                    self.committed_text = text;
                }
                // Phantom filtering applies to the tail as to a final: a
                // silent stretch must not write "Thank you." into the field.
                let tail = phantom::keep(&t.text, t.no_speech, prompt);
                let text = join(&self.committed_text, tail.as_deref());
                if !text.is_empty() {
                    self.to_owner(EV_PARTIAL, TextEvent { session, segment, text: &text });
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

/// `head` and `tail` as one text.
fn join(head: &str, tail: Option<&str>) -> String {
    match (head.is_empty(), tail) {
        (_, None) => head.to_string(),
        (true, Some(t)) => t.to_string(),
        (false, Some(t)) => format!("{head} {t}"),
    }
}

/// The mute gate held open for a headset session, closed again however the
/// session ends.
struct HeadsetMode(u64);

impl HeadsetMode {
    fn on(session: u64) -> Self {
        GATE.set_headset(session, true);
        Self(session)
    }
}

impl Drop for HeadsetMode {
    fn drop(&mut self) {
        GATE.set_headset(self.0, false);
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
    // Headset mode opens the mute gate for as long as this session runs.
    let _headset = config.headset.then(|| HeadsetMode::on(session));
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
        device: None,
        segment: 0,
        pending_finals: 0,
        partial_running: false,
        partial_started: Instant::now(),
        next_partial: Instant::now(),
        partial_speech: 0,
        committed_text: String::new(),
        committed_samples: 0,
        level_sum: 0.0,
        level_n: 0,
        last_level: Instant::now(),
        was_paused: false,
        silent: 0,
        silent_told: false,
        over_voice: None,
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
    match loaded {
        Ok(device) => listener.device = device,
        Err(e) => {
            listener.to_owner(EV_ERROR, ErrorEvent { session, code: e });
            listener.state("stopped", Some(e));
            return;
        }
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
    use app_core::sync::LockExt;
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
            barge_in: || {},
            pacing: Pacing::LIVE,
        }
    }

    /// Plays `audio` in 10 ms pieces, then keeps the stream open silently.
    struct FakeSource {
        audio: Vec<f32>,
        gap_at: Option<usize>,
        fail_start: Option<VoiceError>,
        /// Sleep after each 10 ms piece, to play it at a chosen speed.
        pace: Option<Duration>,
    }

    impl AudioSource for FakeSource {
        fn start(&mut self, sink: SyncSender<Frames>) -> Result<(), VoiceError> {
            if let Some(e) = self.fail_start {
                return Err(e);
            }
            let audio = std::mem::take(&mut self.audio);
            let gap_at = self.gap_at;
            let pace = self.pace;
            std::thread::spawn(move || {
                for (i, piece) in audio.chunks(160).enumerate() {
                    let after_gap = gap_at == Some(i);
                    if sink.send(Frames::Audio { samples: piece.to_vec(), after_gap }).is_err() {
                        return;
                    }
                    if let Some(pace) = pace {
                        std::thread::sleep(pace);
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

    /// Answers each run with its text and the number of final runs so far (the
    /// previews, which start at once, do not move it), counting every run.
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
            // "#len": one word per 20 ms of audio, so a text shows how much
            // audio it was made from.
            let text = if self.text == "#len" {
                vec!["w"; audio.len() / 320].join(" ")
            } else if self.text.starts_with('[') { self.text.to_string() } else { format!("{} {}", self.text, calls.iter().filter(|(_, partial)| !partial).count()) };
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
        // Generous: paced sources sleep per piece, and under the full suite's
        // load those sleeps overshoot; the tests check order, not speed.
        let deadline = Instant::now() + Duration::from_secs(30);
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
    fn a_headset_session_opens_the_gate_until_it_ends() {
        let gate = MuteGate::new();
        let t0 = Instant::now();
        gate.set_speaking(true, t0);
        assert!(gate.muted(t0));
        gate.set_headset(5, true);
        assert!(!gate.muted(t0), "the voice is in the ears, not the mic");
        // An older session ending late leaves the newer one's mode alone.
        gate.set_headset(4, false);
        assert!(!gate.muted(t0));
        gate.set_headset(5, false);
        assert!(gate.muted(t0));
    }

    static BARGED: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

    fn count_barge_in() {
        BARGED.fetch_add(1, Ordering::SeqCst);
    }

    /// Runs `speech()` through a session while the voice speaks; how many
    /// times it barged in.
    fn barge_ins(headset: bool) -> usize {
        let _serial = GATE_SERIAL.lock_ok();
        BARGED.store(0, Ordering::SeqCst);
        GATE.set_speaking(true, Instant::now());
        let events = RecordingEvents::new();
        let (factory, _) = factory();
        let cfg = SessionConfig { headset, barge_in: count_barge_in, ..config(9) };
        let (control, thread) = spawn(&events, cfg, FakeSource { audio: speech(), gap_at: None, fail_start: None, pace: None }, factory);
        wait_for(&events, EV_FINAL, 1);
        control.stop();
        thread.join().unwrap();
        assert!(GATE.muted(Instant::now()), "the ended session closed the gate again");
        GATE.set_speaking(false, Instant::now());
        BARGED.load(Ordering::SeqCst)
    }

    /// Runs `audio` through a Headset session while the voice speaks (the
    /// fake barge-in does not stop it): the final's text and the number of
    /// transcriptions run.
    fn headset_final(audio: Vec<f32>) -> (String, usize) {
        let _serial = GATE_SERIAL.lock_ok();
        GATE.set_speaking(true, Instant::now());
        let events = RecordingEvents::new();
        let (factory, calls) = factory();
        let cfg = SessionConfig { headset: true, barge_in: count_barge_in, ..config(9) };
        let (control, thread) = spawn(&events, cfg, FakeSource { audio, gap_at: None, fail_start: None, pace: None }, factory);
        wait_for(&events, EV_FINAL, 1);
        control.stop();
        thread.join().unwrap();
        GATE.set_speaking(false, Instant::now());
        let text = events.payloads(EV_FINAL)[0]["text"].as_str().unwrap().to_string();
        let ran = calls.lock().unwrap().iter().filter(|(_, partial)| !partial).count();
        (text, ran)
    }

    #[test]
    fn headset_mode_drops_a_segment_that_began_over_the_voice_and_ended_with_it() {
        // 300 ms of tone opens a segment (260 ms of speech) and is over as
        // the voice's echo would be: the user did not talk over it.
        let mut echo = hiss(500);
        echo.extend(tone(330, 220.0, 0.2));
        echo.extend(hiss(1000));
        assert_eq!(headset_final(echo), (String::new(), 0), "the voice's own words are not transcribed");
        // Speech that goes on well past the voice's stop is a barge-in: kept.
        let mut spoken = hiss(500);
        spoken.extend(tone(1600, 220.0, 0.2));
        spoken.extend(hiss(1000));
        let (text, ran) = headset_final(spoken);
        assert_eq!((text.as_str(), ran), ("words 1", 1));
    }

    #[test]
    fn talking_over_the_voice_with_a_headset_stops_it() {
        assert_eq!(barge_ins(true), 1);
        assert_eq!(barge_ins(false), 0, "without a headset only the key interrupts");
    }

    #[test]
    fn speech_becomes_one_final_for_the_owner_only() {
        let events = RecordingEvents::new();
        let (factory, _) = factory();
        let (control, thread) = spawn(&events, config(7), FakeSource { audio: speech(), gap_at: None, fail_start: None, pace: None }, factory);
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

    fn payloads_of(all: &[app_core::ctx::RecordedEvent], event: &str) -> Vec<serde_json::Value> {
        all.iter().filter(|e| e.event == event).map(|e| serde_json::from_str(&e.payload).unwrap()).collect()
    }

    fn words(event: &serde_json::Value) -> usize {
        event["text"].as_str().unwrap().split_whitespace().count()
    }

    /// 10 s of speech in five phrases with 500 ms seams, then the closing silence.
    fn phrases() -> Vec<f32> {
        let mut audio = hiss(500);
        for i in 0..5 {
            audio.extend(tone(1500, 200.0 + 20.0 * i as f32, 0.2));
            audio.extend(hiss(500));
        }
        audio.extend(hiss(1000));
        audio
    }

    #[test]
    fn every_partial_is_the_whole_open_segment_and_none_follows_its_final() {
        let events = RecordingEvents::new();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let factory = FakeFactory { fail: None, calls: calls.clone(), text: "#len" };
        // Back to back previews, and a seam committed once 3 s have gathered.
        let pacing = Pacing { min_gap: Duration::ZERO, max_gap: Duration::ZERO, commit_tail: 3 * RATE as usize };
        let cfg = SessionConfig { pacing, ..config(4) };
        let source = FakeSource { audio: phrases(), gap_at: None, fail_start: None, pace: Some(Duration::from_millis(2)) };
        let (control, thread) = spawn(&events, cfg, source, factory);
        wait_for(&events, EV_FINAL, 1);
        control.stop();
        thread.join().unwrap();

        let all = events.take();
        let last_partial = all.iter().rposition(|e| e.event == EV_PARTIAL).expect("partials");
        let final_at = all.iter().position(|e| e.event == EV_FINAL).unwrap();
        assert!(last_partial < final_at, "a partial arrived after its segment's final");

        let partials = payloads_of(&all, EV_PARTIAL);
        let final_words = words(&payloads_of(&all, EV_FINAL)[0]);
        let counts: Vec<usize> = partials.iter().map(words).collect();
        assert!(partials.iter().all(|p| p["segment"] == 1 && p["session"] == 4));
        assert!(counts.windows(2).all(|w| w[0] <= w[1]), "a partial lost words: {counts:?}");
        assert!(counts.iter().all(|c| *c <= final_words), "{counts:?} vs final {final_words}");
        // A tail-only preview (the old 5 s) could not reach this far.
        assert!(*counts.last().unwrap() * 100 >= final_words * 80, "{counts:?} vs final {final_words}");
        // The first one is out within a second of speech.
        assert!(counts[0] <= 50, "{counts:?}");

        // Whole segment, still bounded: a seam was transcribed once (a
        // non-partial run besides the final) and previews ran on what follows.
        let calls = calls.lock().unwrap().clone();
        assert!(calls.iter().filter(|(_, partial)| !partial).count() >= 2, "{calls:?}");
        let longest_tail = calls.iter().filter(|(_, partial)| *partial).map(|(n, _)| *n).max().unwrap();
        assert!(longest_tail < final_words * 320 * 7 / 10, "tails kept growing: {longest_tail} of {}", final_words * 320);
    }

    #[test]
    fn the_first_partial_comes_while_the_user_is_still_talking() {
        let events = RecordingEvents::new();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let factory = FakeFactory { fail: None, calls, text: "#len" };
        let mut audio = hiss(500);
        audio.extend(tone(2000, 220.0, 0.2));
        audio.extend(hiss(1000));
        let source = FakeSource { audio, gap_at: None, fail_start: None, pace: Some(Duration::from_millis(2)) };
        let (control, thread) = spawn(&events, config(1), source, factory);
        wait_for(&events, EV_FINAL, 1);
        control.stop();
        thread.join().unwrap();
        let all = events.take();
        let first = all.iter().position(|e| e.event == EV_PARTIAL).expect("a partial");
        assert!(first < all.iter().position(|e| e.event == EV_FINAL).unwrap());
        let text = &payloads_of(&all, EV_PARTIAL)[0];
        assert!(words(text) <= 40, "the first preview heard {} words (20 ms each)", words(text));
    }

    #[test]
    fn a_phantom_partial_writes_nothing() {
        let events = RecordingEvents::new();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let factory = FakeFactory { fail: None, calls: calls.clone(), text: "[BLANK_AUDIO]" };
        let source = FakeSource { audio: phrases(), gap_at: None, fail_start: None, pace: Some(Duration::from_millis(2)) };
        let (control, thread) = spawn(&events, config(1), source, factory);
        wait_for(&events, EV_FINAL, 1);
        control.stop();
        thread.join().unwrap();
        assert!(calls.lock().unwrap().iter().any(|(_, partial)| *partial), "previews did run");
        assert!(events.payloads(EV_PARTIAL).is_empty());
    }

    #[test]
    fn the_gap_follows_how_long_the_device_takes_within_bounds() {
        let p = Pacing::LIVE;
        assert_eq!(p.gap_after(Duration::from_millis(80)), Duration::from_millis(300));
        assert_eq!(p.gap_after(Duration::from_millis(800)), Duration::from_millis(400));
        assert_eq!(p.gap_after(Duration::from_secs(5)), Duration::from_millis(700));
        let now = Pacing { min_gap: Duration::ZERO, max_gap: Duration::ZERO, ..p };
        assert_eq!(now.gap_after(Duration::from_secs(1)), Duration::ZERO);
    }

    #[test]
    fn joining_committed_text_and_a_tail() {
        assert_eq!(join("", Some("b")), "b");
        assert_eq!(join("a", Some("b")), "a b");
        assert_eq!(join("a", None), "a");
        assert_eq!(join("", None), "");
    }

    #[test]
    fn stopping_mid_sentence_still_transcribes_it() {
        let events = RecordingEvents::new();
        let (factory, calls) = factory();
        let mut audio = hiss(500);
        audio.extend(tone(600, 220.0, 0.2));
        let (control, thread) = spawn(&events, config(1), FakeSource { audio, gap_at: None, fail_start: None, pace: None }, factory);
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
        let (control, thread) = spawn(&events, config(1), FakeSource { audio, gap_at: None, fail_start: None, pace: None }, factory);
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
        let source = FakeSource { audio: speech(), gap_at: None, fail_start: None, pace: None };
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
        let source = FakeSource { audio: vec![0.0; 4 * RATE as usize], gap_at: None, fail_start: None, pace: None };
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
        let (control, thread) = spawn(&events, config(3), FakeSource { audio, gap_at: None, fail_start: None, pace: None }, factory);
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
        let (control, thread) = spawn(&events, config(1), FakeSource { audio, gap_at: Some(gap), fail_start: None, pace: None }, factory);
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
        let (_control, thread) = spawn(&events, config(3), FakeSource { audio: speech(), gap_at: None, fail_start: None, pace: None }, factory);
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
        let (control, thread) = spawn(&events, config(1), FakeSource { audio: speech(), gap_at: None, fail_start: None, pace: None }, factory);
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

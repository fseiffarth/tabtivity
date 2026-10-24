//! Read-aloud (docs/desktop_voice_plan.md step 2c): one speaker thread for
//! the machine, a queue of reads, and the OS voice behind [`TtsEngine`] —
//! SSIP to speech-dispatcher on Linux ([`super::ssip`]), the `tts` crate's
//! WinRT / AVFoundation voices on Windows and macOS. Phase 2's Piper would be
//! one more engine; nothing above the trait changes.
//!
//! The mute gate ([`super::session::GATE`]) goes up before the first chunk
//! of a read and down after the last one; `voice:speaking` `done` is sent
//! only after the gate's tail, so a hands-free loop that reopens the mic on
//! it never hears the voice's last syllable.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use app_core::sync::LockExt;
use app_core::CoreCtx;
use serde::Serialize;

use super::session::{GATE, MUTE_TAIL};
use super::VoiceError;

pub use super::ssip::Spoken;

pub const EV_SPEAKING: &str = "voice:speaking";

/// An OS voice. `say` blocks until the chunk is spoken or `cancel` stops it.
pub trait TtsEngine {
    fn say(&mut self, chunk: &str, lang: &str, rate: f32, cancel: &AtomicBool) -> Result<Spoken, VoiceError>;
}

/// Builds the engine on the speaker thread (the `tts` crate's handle must
/// stay on the thread that made it).
pub type EngineFactory = Box<dyn FnOnce() -> Result<Box<dyn TtsEngine>, VoiceError> + Send>;

/// `voice:speaking`, broadcast: what became of read `readId`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SpeakingEvent<'a> {
    read_id: &'a str,
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<VoiceError>,
}

struct Read {
    id: String,
    chunks: Vec<String>,
    lang: String,
    rate: f32,
    /// The stop count when it was queued: a later stop drops it.
    generation: u64,
}

/// The speaker thread's handle.
struct Speaker {
    reads: Sender<Read>,
    cancel: Arc<AtomicBool>,
    generation: Arc<AtomicU64>,
    thread: std::thread::JoinHandle<()>,
}

fn emit(ctx: &CoreCtx, read_id: &str, state: &'static str, reason: Option<VoiceError>) {
    ctx.emit(EV_SPEAKING, SpeakingEvent { read_id, state, reason });
}

/// The speaker thread: one read at a time, each chunk in turn; a stop
/// cancels the chunk being said and drops every read queued before it.
fn run(ctx: CoreCtx, factory: EngineFactory, reads: Receiver<Read>, cancel: Arc<AtomicBool>, generation: Arc<AtomicU64>) {
    let mut engine = match factory() {
        Ok(engine) => engine,
        Err(e) => {
            // Every read that comes is refused the same way.
            for read in reads {
                emit(&ctx, &read.id, "failed", Some(e));
            }
            return;
        }
    };
    while let Ok(read) = reads.recv() {
        if read.generation < generation.load(Ordering::SeqCst) {
            emit(&ctx, &read.id, "stopped", None);
            continue;
        }
        cancel.store(false, Ordering::SeqCst);
        GATE.set_speaking(true, Instant::now());
        emit(&ctx, &read.id, "started", None);
        let mut outcome: Result<Spoken, VoiceError> = Ok(Spoken::Done);
        for chunk in &read.chunks {
            if read.generation < generation.load(Ordering::SeqCst) {
                outcome = Ok(Spoken::Cancelled);
                break;
            }
            outcome = engine.say(chunk, &read.lang, read.rate, &cancel);
            if !matches!(outcome, Ok(Spoken::Done)) {
                break;
            }
        }
        GATE.set_speaking(false, Instant::now());
        match outcome {
            Ok(Spoken::Done) => {
                // The audio still in the output device: the mic stays deaf
                // through it, and "done" means the room is quiet.
                std::thread::sleep(MUTE_TAIL);
                emit(&ctx, &read.id, "done", None);
            }
            Ok(Spoken::Cancelled) => emit(&ctx, &read.id, "stopped", None),
            Err(e) => emit(&ctx, &read.id, "failed", Some(e)),
        }
    }
}

static SPEAKER: Mutex<Option<Speaker>> = Mutex::new(None);

/// Queue a read (after whatever is being said; `replace` stops that first).
/// The speaker thread starts with the first read, on `factory`'s engine.
pub fn queue(ctx: &CoreCtx, factory: impl FnOnce() -> EngineFactory, id: String, chunks: Vec<String>, lang: String, rate: f32, replace: bool) -> Result<(), VoiceError> {
    let mut guard = SPEAKER.lock_ok();
    if guard.as_ref().is_some_and(|s| s.thread.is_finished()) {
        *guard = None;
    }
    if guard.is_none() {
        let (tx, rx) = mpsc::channel();
        let cancel = Arc::new(AtomicBool::new(false));
        let generation = Arc::new(AtomicU64::new(0));
        let thread = {
            let (ctx, cancel, generation, factory) = (ctx.clone(), cancel.clone(), generation.clone(), factory());
            std::thread::Builder::new()
                .name("voice-speaker".into())
                .spawn(move || run(ctx, factory, rx, cancel, generation))
                .map_err(|_| VoiceError::SpeechFailed)?
        };
        *guard = Some(Speaker { reads: tx, cancel, generation, thread });
    }
    let speaker = guard.as_ref().ok_or(VoiceError::SpeechFailed)?;
    if replace {
        stop_speaker(speaker);
    }
    let generation = speaker.generation.load(Ordering::SeqCst);
    speaker
        .reads
        .send(Read { id, chunks, lang, rate, generation })
        .map_err(|_| VoiceError::SpeechFailed)
}

fn stop_speaker(speaker: &Speaker) {
    speaker.generation.fetch_add(1, Ordering::SeqCst);
    speaker.cancel.store(true, Ordering::SeqCst);
}

/// Stop what is being said and everything queued.
pub fn stop() {
    if let Some(speaker) = SPEAKER.lock_ok().as_ref() {
        stop_speaker(speaker);
    }
}

/// The exit teardown: stop, close the queue, and wait at most `limit` for
/// the engine to have cancelled its speech.
pub fn stop_for_exit(limit: Duration) {
    let speaker = SPEAKER.lock_ok().take();
    let Some(speaker) = speaker else { return };
    stop_speaker(&speaker);
    let Speaker { reads, thread, .. } = speaker;
    drop(reads);
    let deadline = Instant::now() + limit;
    while !thread.is_finished() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    if thread.is_finished() {
        let _ = thread.join();
    }
}

// ── Engines ───────────────────────────────────────────────────────────────

/// speech-dispatcher over its socket. A connection that stops answering is
/// dropped; the next chunk connects afresh (and may start the server).
#[cfg(target_os = "linux")]
pub struct SsipEngine {
    client: Option<super::ssip::Client<std::os::unix::net::UnixStream>>,
}

#[cfg(target_os = "linux")]
impl SsipEngine {
    pub fn new() -> Self {
        Self { client: None }
    }
}

#[cfg(target_os = "linux")]
impl Default for SsipEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(target_os = "linux")]
impl TtsEngine for SsipEngine {
    fn say(&mut self, chunk: &str, lang: &str, rate: f32, cancel: &AtomicBool) -> Result<Spoken, VoiceError> {
        use super::ssip::{speak_limit, transport};
        if self.client.is_none() {
            self.client = Some(transport::connect(&client_name()).map_err(VoiceError::from)?);
        }
        let client = self.client.as_mut().ok_or(VoiceError::NoSpeechServer)?;
        let result = client
            .configure(lang, rate)
            .and_then(|()| client.speak(chunk))
            .and_then(|id| client.wait(id, speak_limit(chunk, rate), cancel));
        result.map_err(|broken| {
            self.client = None;
            VoiceError::from(broken)
        })
    }
}

/// `user:application:component`, as speech-dispatcher lists its clients.
#[cfg(target_os = "linux")]
fn client_name() -> String {
    let user = std::env::var("USER").unwrap_or_default();
    let user: String = user.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
    format!("{}:{}:read-aloud", if user.is_empty() { "user" } else { &user }, crate::app_slug!())
}

/// The `tts` crate on Windows (WinRT) and macOS (AVFoundation). Its
/// callbacks run under the crate's own locks and macOS's need a run loop, so
/// the end of a chunk is read by polling `is_speaking` instead.
#[cfg(all(feature = "voice-io", not(target_os = "linux")))]
pub struct OsEngine {
    tts: tts::Tts,
    lang: Option<String>,
}

#[cfg(all(feature = "voice-io", not(target_os = "linux")))]
impl OsEngine {
    pub fn new() -> Result<Self, VoiceError> {
        #[cfg(windows)]
        // SAFETY: initializing COM for this thread (the speaker's own) is
        // what WinRT activation needs; an already-initialized apartment
        // answers S_FALSE / RPC_E_CHANGED_MODE, both harmless here.
        unsafe {
            let _ = windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_MULTITHREADED);
        }
        let tts = tts::Tts::default().map_err(|_| VoiceError::NoSpeechServer)?;
        Ok(Self { tts, lang: None })
    }

    fn set_lang(&mut self, lang: &str) {
        let primary = lang.split(['-', '_']).next().unwrap_or("").to_ascii_lowercase();
        if primary.is_empty() || self.lang.as_deref() == Some(primary.as_str()) {
            return;
        }
        if let Ok(voices) = self.tts.voices() {
            if let Some(voice) = voices.iter().find(|v| v.language().primary_language().eq_ignore_ascii_case(&primary)) {
                let _ = self.tts.set_voice(voice);
            }
        }
        self.lang = Some(primary);
    }
}

#[cfg(all(feature = "voice-io", not(target_os = "linux")))]
impl TtsEngine for OsEngine {
    fn say(&mut self, chunk: &str, lang: &str, rate: f32, cancel: &AtomicBool) -> Result<Spoken, VoiceError> {
        self.set_lang(lang);
        let normal = self.tts.normal_rate();
        let target = (normal * rate.clamp(0.5, 2.0)).clamp(self.tts.min_rate(), self.tts.max_rate());
        let _ = self.tts.set_rate(target);
        self.tts.speak(chunk.to_string(), false).map_err(|_| VoiceError::SpeechFailed)?;
        let limit = super::ssip::speak_limit(chunk, rate);
        let started = Instant::now();
        let mut heard_speaking = false;
        loop {
            if cancel.load(Ordering::SeqCst) {
                let _ = self.tts.stop();
                return Ok(Spoken::Cancelled);
            }
            let speaking = self.tts.is_speaking().unwrap_or(false);
            heard_speaking |= speaking;
            // Done once it spoke and fell silent, or never started within a
            // grace period (an empty or unspeakable chunk).
            if (heard_speaking && !speaking) || (!heard_speaking && started.elapsed() > Duration::from_millis(1500)) {
                return Ok(Spoken::Done);
            }
            if started.elapsed() > limit {
                let _ = self.tts.stop();
                return Err(VoiceError::SpeechFailed);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

/// This machine's OS voice, built on the speaker thread.
pub fn os_engine() -> EngineFactory {
    Box::new(|| {
        #[cfg(target_os = "linux")]
        {
            Ok(Box::new(SsipEngine::new()) as Box<dyn TtsEngine>)
        }
        #[cfg(all(feature = "voice-io", not(target_os = "linux")))]
        {
            Ok(Box::new(OsEngine::new()?) as Box<dyn TtsEngine>)
        }
        #[cfg(all(not(feature = "voice-io"), not(target_os = "linux")))]
        {
            Err(VoiceError::NotBuilt)
        }
    })
}

/// Whether read-aloud can run here, without starting anything.
pub fn availability() -> Option<VoiceError> {
    #[cfg(target_os = "linux")]
    {
        (!super::ssip::transport::available()).then_some(VoiceError::NoSpeechServer)
    }
    #[cfg(all(feature = "voice-io", not(target_os = "linux")))]
    {
        None
    }
    #[cfg(all(not(feature = "voice-io"), not(target_os = "linux")))]
    {
        Some(VoiceError::NotBuilt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use app_core::{Caller, CoreState, RecordingEvents};

    /// What the fake voice said, chunk by chunk.
    type Said = Arc<Mutex<Vec<String>>>;

    /// Says each chunk in `ms`, recording it; a cancel ends it at once.
    struct Fake {
        said: Said,
        ms: u64,
    }

    impl TtsEngine for Fake {
        fn say(&mut self, chunk: &str, _lang: &str, _rate: f32, cancel: &AtomicBool) -> Result<Spoken, VoiceError> {
            let until = Instant::now() + Duration::from_millis(self.ms);
            while Instant::now() < until {
                if cancel.load(Ordering::SeqCst) {
                    return Ok(Spoken::Cancelled);
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            self.said.lock().unwrap().push(chunk.to_string());
            Ok(Spoken::Done)
        }
    }

    fn states(events: &RecordingEvents) -> Vec<(String, String)> {
        events
            .payloads(EV_SPEAKING)
            .iter()
            .map(|p| (p["readId"].as_str().unwrap().to_string(), p["state"].as_str().unwrap().to_string()))
            .collect()
    }

    fn wait_for(events: &RecordingEvents, n: usize) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while states(events).len() < n {
            assert!(Instant::now() < deadline, "{:?}", states(events));
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// The speaker is one per process: the tests take turns with it.
    static SERIAL: Mutex<()> = Mutex::new(());

    fn setup(ms: u64) -> (CoreCtx, Arc<RecordingEvents>, Said, impl Fn() -> EngineFactory) {
        stop_for_exit(Duration::from_secs(2));
        let events = RecordingEvents::new();
        let ctx = CoreCtx::new(Arc::new(CoreState::new()), events.clone(), Caller::System);
        let said = Arc::new(Mutex::new(Vec::new()));
        let s = said.clone();
        let factory = move || -> EngineFactory {
            let s = s.clone();
            Box::new(move || Ok(Box::new(Fake { said: s, ms }) as Box<dyn TtsEngine>))
        };
        (ctx, events, said, factory)
    }

    fn chunks(c: &[&str]) -> Vec<String> {
        c.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn reads_are_spoken_in_turn_with_done_after_the_tail() {
        let _serial = SERIAL.lock_ok();
        let (ctx, events, said, factory) = setup(10);
        queue(&ctx, &factory, "a".into(), chunks(&["One.", "Two."]), "de".into(), 1.0, false).unwrap();
        queue(&ctx, &factory, "b".into(), chunks(&["Three."]), "de".into(), 1.0, false).unwrap();
        wait_for(&events, 4);
        assert_eq!(states(&events), [("a".into(), "started".into()), ("a".into(), "done".into()), ("b".into(), "started".into()), ("b".into(), "done".into())]);
        assert_eq!(*said.lock().unwrap(), ["One.", "Two.", "Three."]);
        assert!(!GATE.muted(Instant::now()));
        stop_for_exit(Duration::from_secs(1));
    }

    #[test]
    fn the_mic_is_muted_while_it_speaks() {
        let _serial = SERIAL.lock_ok();
        let (ctx, events, _, factory) = setup(300);
        queue(&ctx, &factory, "a".into(), chunks(&["Long."]), "en".into(), 1.0, false).unwrap();
        wait_for(&events, 1);
        assert!(GATE.muted(Instant::now()));
        wait_for(&events, 2);
        stop_for_exit(Duration::from_secs(1));
    }

    #[test]
    fn a_stop_cancels_the_read_and_drops_the_queue() {
        let _serial = SERIAL.lock_ok();
        let (ctx, events, said, factory) = setup(2_000);
        queue(&ctx, &factory, "a".into(), chunks(&["Long.", "Longer."]), "en".into(), 1.0, false).unwrap();
        queue(&ctx, &factory, "b".into(), chunks(&["Queued."]), "en".into(), 1.0, false).unwrap();
        wait_for(&events, 1);
        stop();
        wait_for(&events, 3);
        assert_eq!(states(&events), [("a".into(), "started".into()), ("a".into(), "stopped".into()), ("b".into(), "stopped".into())]);
        assert!(said.lock().unwrap().is_empty());
        stop_for_exit(Duration::from_secs(1));
    }

    #[test]
    fn replace_says_the_new_read_instead() {
        let _serial = SERIAL.lock_ok();
        let (ctx, events, said, factory) = setup(1_000);
        queue(&ctx, &factory, "a".into(), chunks(&["Old."]), "en".into(), 1.0, false).unwrap();
        wait_for(&events, 1);
        queue(&ctx, &factory, "b".into(), chunks(&["New."]), "en".into(), 1.0, true).unwrap();
        wait_for(&events, 4);
        assert_eq!(states(&events)[1], ("a".into(), "stopped".into()));
        assert_eq!(*said.lock().unwrap(), ["New."]);
        stop_for_exit(Duration::from_secs(1));
    }

    #[test]
    fn an_engine_that_cannot_start_fails_each_read() {
        let _serial = SERIAL.lock_ok();
        let (ctx, events, _, _) = setup(0);
        let failing = || -> EngineFactory { Box::new(|| Err(VoiceError::NoSpeechServer)) };
        queue(&ctx, failing, "a".into(), chunks(&["x"]), "en".into(), 1.0, false).unwrap();
        wait_for(&events, 1);
        assert_eq!(events.payloads(EV_SPEAKING)[0], serde_json::json!({ "readId": "a", "state": "failed", "reason": "no-speech-server" }));
        stop_for_exit(Duration::from_secs(1));
    }
}

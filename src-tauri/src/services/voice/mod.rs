//! The desktop's speech engine (docs/desktop_voice_plan.md, step 2): the
//! microphone, voice detection and whisper.cpp in the backend, so the Chat
//! can be dictated to where the webview has no speech API (WebKitGTK).
//!
//! The backend owns the audio; the renderer owns the words. Nothing here ever
//! sends a prompt: `voice:final` text goes into the composer's draft, and the
//! composer's own `send()` is the only way out.
//!
//! One listener per machine: the mic belongs to one Chat tab at a time, and a
//! new start stops the old session. Every event carries the session id, so a
//! final that arrives for a stopped session is ignored by the renderer.
//!
//! Gating (step 0, step 2): this module needs `desktop`; the catalog, the CPU
//! check, the voice detector, the phantom filter and the session core compile
//! with it, so every check covers them. The capture needs `voice-io` (`cpal`),
//! whisper needs `voice`; without them [`capture`] and [`stt`] answer
//! [`VoiceError::NotBuilt`]. Commands are registered in every desktop build.
//! `AppHandle`-free: the session emits through a cloned [`CoreCtx`].

pub mod capture;
pub mod cpu;
pub mod models;
pub mod phantom;
pub mod resample;
pub mod session;
pub mod stt;
pub mod vad;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use app_core::{ClientId, CoreCtx};
use serde::Serialize;

use app_core::sync::LockExt;

pub use session::{Control, ListenMode};

/// Events, in the tree's `scope:verb` style.
pub const EV_LEVEL: &str = "voice:level";
pub const EV_VAD: &str = "voice:vad";
pub const EV_PARTIAL: &str = "voice:partial";
pub const EV_FINAL: &str = "voice:final";
pub const EV_STATE: &str = "voice:state";
pub const EV_OWNER: &str = "voice:owner";
pub const EV_ERROR: &str = "voice:error";

/// Why voice input or output cannot run, or a listen failed. One closed set,
/// sent as kebab-case codes; the renderer maps each to its own i18n key
/// (`src/lib/voice/`), so no key crosses from Rust.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum VoiceError {
    /// This build has no speech engine (`voice` / `voice-io` off).
    NotBuilt,
    /// The CPU lacks AVX2/FMA (user decision 2026-10-23).
    CpuUnsupported,
    /// The chosen whisper model is not installed.
    ModelMissing,
    /// A model id that is not a whisper model in the catalog.
    UnknownModel,
    /// An argument outside its allowed range.
    BadArgument,
    /// No input device answered.
    NoDevice,
    /// The OS refused the microphone.
    PermissionDenied,
    /// Another program holds the microphone.
    DeviceBusy,
    /// The capture failed for another reason.
    DeviceFailed,
    /// The model would not load, or whisper failed.
    ModelFailed,
    /// The session named is not the active one.
    NotActive,
}

impl VoiceError {
    pub fn code(self) -> &'static str {
        match self {
            Self::NotBuilt => "not-built",
            Self::CpuUnsupported => "cpu-unsupported",
            Self::ModelMissing => "model-missing",
            Self::UnknownModel => "unknown-model",
            Self::BadArgument => "bad-argument",
            Self::NoDevice => "no-device",
            Self::PermissionDenied => "permission-denied",
            Self::DeviceBusy => "device-busy",
            Self::DeviceFailed => "device-failed",
            Self::ModelFailed => "model-failed",
            Self::NotActive => "not-active",
        }
    }
}

/// Commands answer errors as the bare code.
impl From<VoiceError> for String {
    fn from(e: VoiceError) -> String {
        e.code().to_string()
    }
}

/// Who holds the mic: the calling window (from the command's context, never
/// the payload) and the Chat tab in it. Step 9's navigation adds `Window`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Owner {
    Tab { client: ClientId, key: String },
}

impl Owner {
    pub fn client(&self) -> &ClientId {
        match self {
            Owner::Tab { client, .. } => client,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnerInfo {
    pub kind: &'static str,
    pub window: String,
    pub tab_key: String,
}

impl From<&Owner> for OwnerInfo {
    fn from(owner: &Owner) -> Self {
        match owner {
            Owner::Tab { client, key } => {
                OwnerInfo { kind: "tab", window: client.as_str().to_string(), tab_key: key.clone() }
            }
        }
    }
}

/// `voice:owner`, broadcast: who holds the mic now (`None`: nobody).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnerEvent {
    pub session: Option<u64>,
    pub owner: Option<OwnerInfo>,
    pub mode: Option<ListenMode>,
}

/// The active session as `voice_status` reports it, so a reloaded window's
/// indicator recovers.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session: u64,
    pub owner: OwnerInfo,
    pub mode: ListenMode,
    pub paused: bool,
}

/// `voice_status`' answer.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    /// Whether this CPU can run whisper (false: `listen` is `cpu-unsupported`).
    pub cpu: bool,
    pub models: Vec<models::ModelState>,
    pub default_model: &'static str,
    /// Why listening cannot start at all; `None` when it can (a model may
    /// still need installing: `models`).
    pub listen: Option<VoiceError>,
    /// Why read-aloud cannot run; `None` when it can.
    pub speak: Option<VoiceError>,
    pub session: Option<SessionInfo>,
}

pub fn status() -> VoiceStatus {
    let cpu = cpu::supported();
    VoiceStatus {
        cpu,
        models: models::states(),
        default_model: models::DEFAULT_MODEL,
        listen: if !stt::BUILT || !capture::BUILT {
            Some(VoiceError::NotBuilt)
        } else if !cpu {
            Some(VoiceError::CpuUnsupported)
        } else {
            None
        },
        // Read-aloud lands with step 2c.
        speak: Some(VoiceError::NotBuilt),
        session: ACTIVE.lock_ok().as_ref().map(|a| a.info()),
    }
}

/// What `voice_listen_start` asks for, checked by [`ListenRequest::validate`].
#[derive(Clone, Debug)]
pub struct ListenRequest {
    pub tab_key: String,
    pub model: String,
    pub lang: String,
    pub mode: ListenMode,
    pub pause_ms: u32,
    pub headset: bool,
    pub prompt: Option<String>,
}

/// The hands-free pause's range (plan step 2).
pub const PAUSE_MS: std::ops::RangeInclusive<u32> = 800..=4000;
/// An initial prompt (step 9's name hints) is at most this many characters.
pub const MAX_PROMPT_CHARS: usize = 500;

/// A speech language as whisper takes it: `auto`, or a BCP 47 tag whose
/// primary subtag whisper knows by its two- or three-letter code.
fn valid_lang(lang: &str) -> bool {
    if lang == "auto" {
        return true;
    }
    let mut parts = lang.split('-');
    let primary = parts.next().unwrap_or("");
    (2..=3).contains(&primary.len())
        && primary.bytes().all(|b| b.is_ascii_lowercase())
        && parts.all(|p| (2..=8).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_alphanumeric()))
}

impl ListenRequest {
    /// Every argument in its range; the prompt stripped of control characters
    /// (whisper-rs panics on a NUL) and bounded.
    pub fn validate(mut self) -> Result<Self, VoiceError> {
        if self.tab_key.is_empty() || self.tab_key.len() > 200 || self.tab_key.chars().any(char::is_control) {
            return Err(VoiceError::BadArgument);
        }
        if models::whisper_entry(&self.model).is_none() {
            return Err(VoiceError::UnknownModel);
        }
        if !valid_lang(&self.lang) {
            return Err(VoiceError::BadArgument);
        }
        match self.mode {
            ListenMode::Dictate => self.pause_ms = vad::VadConfig::DICTATE_END_SILENCE_MS,
            ListenMode::HandsFree if !PAUSE_MS.contains(&self.pause_ms) => return Err(VoiceError::BadArgument),
            ListenMode::HandsFree => {}
        }
        self.prompt = self
            .prompt
            .map(|p| {
                p.chars()
                    .map(|c| if c.is_control() { ' ' } else { c })
                    .take(MAX_PROMPT_CHARS)
                    .collect::<String>()
                    .trim()
                    .to_string()
            })
            .filter(|p| !p.is_empty());
        Ok(self)
    }
}

/// The session holding the mic.
struct Active {
    session: u64,
    owner: Owner,
    mode: ListenMode,
    control: Arc<Control>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Active {
    fn info(&self) -> SessionInfo {
        SessionInfo {
            session: self.session,
            owner: OwnerInfo::from(&self.owner),
            mode: self.mode,
            paused: self.control.paused(),
        }
    }
}

static ACTIVE: Mutex<Option<Active>> = Mutex::new(None);
static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);

fn announce_owner(ctx: &CoreCtx, active: Option<&Active>) {
    ctx.emit(
        EV_OWNER,
        OwnerEvent {
            session: active.map(|a| a.session),
            owner: active.map(|a| OwnerInfo::from(&a.owner)),
            mode: active.map(|a| a.mode),
        },
    );
}

/// Start listening for the calling window's tab `req.tab_key`; any other
/// session stops first (its last final still arrives, under its own id).
/// Opens the microphone before answering, so a missing or refused device is
/// this call's error; the model loads on the session's thread (`preparing`).
pub fn listen_start(ctx: &CoreCtx, req: ListenRequest) -> Result<u64, VoiceError> {
    let client = ctx.caller.client().cloned().ok_or(VoiceError::BadArgument)?;
    let req = req.validate()?;
    if !stt::BUILT || !capture::BUILT {
        return Err(VoiceError::NotBuilt);
    }
    if !cpu::supported() {
        return Err(VoiceError::CpuUnsupported);
    }
    let model = models::whisper_entry(&req.model).ok_or(VoiceError::UnknownModel)?;
    if !models::installed(model) {
        return Err(VoiceError::ModelMissing);
    }
    let mut guard = ACTIVE.lock_ok();
    // The old session lets go of the mic first; its last final still comes.
    if let Some(old) = guard.take() {
        old.control.stop();
        announce_owner(ctx, None);
    }
    let source = capture::open()?;
    let control = Arc::new(Control::default());
    let session = NEXT_SESSION.fetch_add(1, Ordering::Relaxed);
    let owner = Owner::Tab { client, key: req.tab_key.clone() };
    let vad_model = Some(models::vad_entry()).filter(|e| models::installed(e)).map(models::model_path);
    let transcriber = stt::Factory { model: models::model_path(model), vad_model };
    let config = session::SessionConfig::from_request(session, owner.clone(), &req);
    let thread = {
        let ctx = ctx.clone();
        let control = control.clone();
        std::thread::Builder::new()
            .name(format!("voice-listen-{session}"))
            .spawn(move || {
                session::run(ctx.clone(), config, control, source, transcriber);
                ended(&ctx, session);
            })
            .map_err(|_| VoiceError::DeviceFailed)?
    };
    *guard = Some(Active { session, owner, mode: req.mode, control, thread: Some(thread) });
    announce_owner(ctx, guard.as_ref());
    Ok(session)
}

/// A session thread returned (a failed device, a model that would not load,
/// or a stop): if it still holds the mic, it no longer does.
fn ended(ctx: &CoreCtx, session: u64) {
    let mut guard = ACTIVE.lock_ok();
    if guard.as_ref().is_some_and(|a| a.session == session) {
        *guard = None;
        announce_owner(ctx, None);
    }
}

/// Pause or resume the active session, keeping its ownership.
pub fn listen_pause(session: u64, paused: bool) -> Result<(), VoiceError> {
    let guard = ACTIVE.lock_ok();
    let active = guard.as_ref().filter(|a| a.session == session).ok_or(VoiceError::NotActive)?;
    active.control.set_paused(paused);
    Ok(())
}

/// Stop session `session`; its open segment is still transcribed. Stopping
/// a session that already ended is not an error.
pub fn listen_stop(ctx: &CoreCtx, session: u64) {
    let mut guard = ACTIVE.lock_ok();
    if guard.as_ref().is_some_and(|a| a.session == session) {
        if let Some(old) = guard.take() {
            old.control.stop();
        }
        announce_owner(ctx, None);
    }
}

/// The owner's window is gone or reloaded: nothing is left to show the mic
/// is on, so it goes off.
pub fn stop_for_window(ctx: &CoreCtx, window: &str) {
    let mut guard = ACTIVE.lock_ok();
    if guard.as_ref().is_some_and(|a| a.owner.client().as_str() == window) {
        if let Some(old) = guard.take() {
            old.control.abort();
        }
        announce_owner(ctx, None);
    }
}

/// `voice_speak`'s bounds: at most this many chunks of at most this many
/// characters, at a rate multiplier in this range.
pub const MAX_SPEAK_CHUNKS: usize = 200;
pub const MAX_CHUNK_CHARS: usize = 1000;
pub const SPEAK_RATE: std::ops::RangeInclusive<f32> = 0.5..=2.0;

/// Read `chunks` aloud as utterance `id`. Read-aloud lands with step 2c;
/// until then the arguments are checked and the answer is `not-built`.
pub fn speak(id: &str, chunks: &[String], lang: &str, rate: f32, _replace: bool) -> Result<(), VoiceError> {
    if id.is_empty()
        || id.len() > 200
        || chunks.len() > MAX_SPEAK_CHUNKS
        || chunks.iter().any(|c| c.chars().count() > MAX_CHUNK_CHARS)
        || !valid_lang(lang)
        || !SPEAK_RATE.contains(&rate)
    {
        return Err(VoiceError::BadArgument);
    }
    Err(VoiceError::NotBuilt)
}

pub fn speak_stop() {}

/// The system voices read-aloud can use (step 2c).
pub fn voices() -> Result<Vec<String>, VoiceError> {
    Err(VoiceError::NotBuilt)
}

/// The `RunEvent::Exit` teardown: abort the session (whisper's abort
/// callback stops a transcription in flight), close the stream, and wait at
/// most half a second for its thread before leaving it behind.
pub fn stop_for_exit() {
    let active = ACTIVE.lock_ok().take();
    let Some(mut active) = active else { return };
    active.control.abort();
    if let Some(thread) = active.thread.take() {
        let deadline = std::time::Instant::now() + Duration::from_millis(500);
        while !thread.is_finished() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        if thread.is_finished() {
            let _ = thread.join();
        }
    }
    stt::release_now();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> ListenRequest {
        ListenRequest {
            tab_key: "tab-1".into(),
            model: models::DEFAULT_MODEL.into(),
            lang: "de".into(),
            mode: ListenMode::HandsFree,
            pause_ms: 1500,
            headset: false,
            prompt: None,
        }
    }

    #[test]
    fn error_codes_are_the_serialized_names() {
        for e in [
            VoiceError::NotBuilt,
            VoiceError::CpuUnsupported,
            VoiceError::ModelMissing,
            VoiceError::UnknownModel,
            VoiceError::BadArgument,
            VoiceError::NoDevice,
            VoiceError::PermissionDenied,
            VoiceError::DeviceBusy,
            VoiceError::DeviceFailed,
            VoiceError::ModelFailed,
            VoiceError::NotActive,
        ] {
            assert_eq!(serde_json::to_value(e).unwrap(), serde_json::json!(e.code()));
        }
    }

    #[test]
    fn a_request_is_checked_against_its_ranges() {
        assert!(request().validate().is_ok());
        for lang in ["auto", "en", "de-DE", "pt-BR", "yue"] {
            assert!(ListenRequest { lang: lang.into(), ..request() }.validate().is_ok(), "{lang}");
        }
        for lang in ["", "DE", "e", "de_DE", "de-", "../x", "de\0"] {
            assert_eq!(ListenRequest { lang: lang.into(), ..request() }.validate().unwrap_err(), VoiceError::BadArgument, "{lang:?}");
        }
        assert_eq!(ListenRequest { model: "silero-vad".into(), ..request() }.validate().unwrap_err(), VoiceError::UnknownModel);
        assert_eq!(ListenRequest { model: "/tmp/x.bin".into(), ..request() }.validate().unwrap_err(), VoiceError::UnknownModel);
        assert_eq!(ListenRequest { pause_ms: 500, ..request() }.validate().unwrap_err(), VoiceError::BadArgument);
        assert_eq!(ListenRequest { pause_ms: 4001, ..request() }.validate().unwrap_err(), VoiceError::BadArgument);
        assert_eq!(ListenRequest { tab_key: String::new(), ..request() }.validate().unwrap_err(), VoiceError::BadArgument);
    }

    #[test]
    fn dictation_uses_its_own_end_silence() {
        let req = ListenRequest { mode: ListenMode::Dictate, pause_ms: 0, ..request() }.validate().unwrap();
        assert_eq!(req.pause_ms, vad::VadConfig::DICTATE_END_SILENCE_MS);
    }

    #[test]
    fn the_prompt_loses_control_characters_and_is_bounded() {
        let req = ListenRequest { prompt: Some(format!("Mail\0Tab\n{}", "x".repeat(900))), ..request() }.validate().unwrap();
        let prompt = req.prompt.unwrap();
        assert!(!prompt.contains('\0') && !prompt.contains('\n'));
        assert!(prompt.chars().count() <= MAX_PROMPT_CHARS);
        assert!(ListenRequest { prompt: Some(" \u{1}\n".into()), ..request() }.validate().unwrap().prompt.is_none());
    }
}

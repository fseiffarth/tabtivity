//! Speech to text: whisper.cpp through `whisper-rs`, on the session's worker
//! thread. The model loads lazily on the first listen and stays loaded for
//! five minutes after the last one, so a dictation right after another does
//! not wait for it again.
//!
//! Needs `voice`; without it [`Factory::load`] answers
//! [`VoiceError::NotBuilt`]. Nothing here may run before `cpu::supported()`
//! said yes: whisper.cpp is built for AVX2/FMA.

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use super::session::{SessionConfig, TranscriberFactory};
#[cfg(not(feature = "voice"))]
use super::session::{Transcriber, Transcript};
use super::VoiceError;

/// Whether this build has whisper at all.
pub const BUILT: bool = cfg!(feature = "voice");

/// The session's transcriber, by the files it loads.
pub struct Factory {
    pub model: PathBuf,
    /// Silero, when installed: confirms a finished segment is speech.
    pub vad_model: Option<PathBuf>,
}

#[cfg(not(feature = "voice"))]
pub enum NoTranscriber {}

#[cfg(not(feature = "voice"))]
impl Transcriber for NoTranscriber {
    fn transcribe(&mut self, _audio: &[f32], _partial: bool) -> Result<Transcript, VoiceError> {
        match *self {}
    }
}

#[cfg(not(feature = "voice"))]
impl TranscriberFactory for Factory {
    type T = NoTranscriber;
    fn load(self, _config: &SessionConfig, _cancel: Arc<AtomicBool>) -> Result<NoTranscriber, VoiceError> {
        Err(VoiceError::NotBuilt)
    }
}

/// Drop the cached model now (the exit teardown).
#[cfg(not(feature = "voice"))]
pub fn release_now() {}

#[cfg(feature = "voice")]
pub use imp::release_now;

#[cfg(feature = "voice")]
impl TranscriberFactory for Factory {
    type T = imp::Whisper;
    fn load(self, config: &SessionConfig, cancel: Arc<AtomicBool>) -> Result<imp::Whisper, VoiceError> {
        imp::Whisper::load(&self, config, cancel)
    }
}

#[cfg(feature = "voice")]
mod imp {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::{Duration, Instant};

    use app_core::sync::LockExt;
    use whisper_rs::{
        FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState, WhisperVadContext,
        WhisperVadContextParams, WhisperVadParams,
    };

    use super::super::session::{SessionConfig, Transcriber, Transcript};
    use super::super::VoiceError;
    use super::Factory;

    /// How long a loaded model stays after the last listen.
    const KEEP_LOADED: Duration = Duration::from_secs(5 * 60);

    struct Cached {
        path: PathBuf,
        ctx: Arc<WhisperContext>,
        last_used: Instant,
    }

    static CACHE: Mutex<Option<Cached>> = Mutex::new(None);
    static REAPER: OnceLock<()> = OnceLock::new();

    fn context(path: &Path) -> Result<Arc<WhisperContext>, VoiceError> {
        let mut cache = CACHE.lock_ok();
        if let Some(cached) = cache.as_mut().filter(|c| c.path == path) {
            cached.last_used = Instant::now();
            return Ok(cached.ctx.clone());
        }
        // whisper.cpp prints its loading log to stderr unless hooked.
        whisper_rs::install_logging_hooks();
        *cache = None;
        let path_str = path.to_str().ok_or(VoiceError::ModelFailed)?;
        let ctx = WhisperContext::new_with_params(path_str, WhisperContextParameters::default())
            .map_err(|_| VoiceError::ModelFailed)?;
        let ctx = Arc::new(ctx);
        *cache = Some(Cached { path: path.to_path_buf(), ctx: ctx.clone(), last_used: Instant::now() });
        REAPER.get_or_init(|| {
            let _ = std::thread::Builder::new().name("voice-model-reaper".into()).spawn(|| loop {
                std::thread::sleep(Duration::from_secs(30));
                let mut cache = CACHE.lock_ok();
                let idle = cache
                    .as_ref()
                    .is_some_and(|c| Arc::strong_count(&c.ctx) == 1 && c.last_used.elapsed() >= KEEP_LOADED);
                if idle {
                    *cache = None;
                }
            });
        });
        Ok(ctx)
    }

    fn touch(ctx: &Arc<WhisperContext>) {
        if let Some(cached) = CACHE.lock_ok().as_mut().filter(|c| Arc::ptr_eq(&c.ctx, ctx)) {
            cached.last_used = Instant::now();
        }
    }

    pub fn release_now() {
        *CACHE.lock_ok() = None;
    }

    pub struct Whisper {
        ctx: Arc<WhisperContext>,
        state: WhisperState,
        /// Built once per session and cloned per run: each setter leaks a
        /// C string, and the language/prompt setters panic on a NUL.
        final_params: FullParams<'static, 'static>,
        partial_params: FullParams<'static, 'static>,
        vad: Option<WhisperVadContext>,
        /// The flag the abort callback reads, kept alive as long as the
        /// params that point at it.
        _cancel: Arc<AtomicBool>,
    }

    /// whisper.cpp's abort callback: true stops the run between steps.
    /// Not `FullParams::set_abort_callback_safe`: in whisper-rs 0.16.0 its
    /// trampoline casts the boxed `dyn FnMut` back to the concrete closure
    /// type, reads garbage and aborts every run ("failed to encode", -6;
    /// found by transcribing real speech, 2026-10-23).
    unsafe extern "C" fn abort_when_set(user_data: *mut std::ffi::c_void) -> bool {
        // SAFETY: `user_data` is `Arc::as_ptr` of the `AtomicBool` the
        // `Whisper` holds for as long as its params can run.
        unsafe { (*(user_data as *const AtomicBool)).load(Ordering::SeqCst) }
    }

    impl Drop for Whisper {
        fn drop(&mut self) {
            touch(&self.ctx);
        }
    }

    /// Whisper's own code for the speech language's primary subtag, as the
    /// `'static` string its tables hold; `None` for auto-detection.
    fn whisper_lang(lang: &str) -> Result<Option<&'static str>, VoiceError> {
        if lang == "auto" {
            return Ok(None);
        }
        let primary = lang.split('-').next().unwrap_or(lang);
        whisper_rs::get_lang_id(primary)
            .and_then(whisper_rs::get_lang_str)
            .map(Some)
            .ok_or(VoiceError::BadArgument)
    }

    impl Whisper {
        pub(super) fn load(factory: &Factory, config: &SessionConfig, cancel: Arc<AtomicBool>) -> Result<Self, VoiceError> {
            let ctx = context(&factory.model)?;
            let state = ctx.create_state().map_err(|_| VoiceError::ModelFailed)?;
            let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).clamp(1, 8) as i32;
            let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
            params.set_n_threads(threads);
            match whisper_lang(&config.lang)? {
                Some(lang) => params.set_language(Some(lang)),
                None => params.set_detect_language(true),
            }
            if let Some(prompt) = config.prompt.as_deref().filter(|p| !p.contains('\0')) {
                params.set_initial_prompt(prompt);
            }
            params.set_no_context(true);
            params.set_suppress_nst(true);
            params.set_print_progress(false);
            params.set_print_realtime(false);
            params.set_print_special(false);
            params.set_print_timestamps(false);
            // SAFETY: the callback only reads the AtomicBool behind the
            // pointer, which `Whisper::_cancel` keeps alive with the params.
            unsafe {
                params.set_abort_callback(Some(abort_when_set));
                params.set_abort_callback_user_data(Arc::as_ptr(&cancel) as *mut std::ffi::c_void);
            }
            let mut partial_params = params.clone();
            partial_params.set_temperature_inc(0.0);
            partial_params.set_single_segment(true);
            let vad = factory
                .vad_model
                .as_deref()
                .and_then(Path::to_str)
                .and_then(|p| WhisperVadContext::new(p, WhisperVadContextParams::default()).ok());
            Ok(Self { ctx, state, final_params: params, partial_params, vad, _cancel: cancel })
        }
    }

    impl Transcriber for Whisper {
        fn transcribe(&mut self, audio: &[f32], partial: bool) -> Result<Transcript, VoiceError> {
            let params = if partial { self.partial_params.clone() } else { self.final_params.clone() };
            self.state.full(params, audio).map_err(|_| VoiceError::ModelFailed)?;
            let mut text = String::new();
            let mut no_speech: f32 = 0.0;
            for segment in self.state.as_iter() {
                if let Ok(piece) = segment.to_str_lossy() {
                    text.push_str(&piece);
                }
                no_speech = no_speech.max(segment.no_speech_probability());
            }
            Ok(Transcript { text: text.trim().to_string(), no_speech })
        }

        fn confirm_speech(&mut self, audio: &[f32]) -> bool {
            let Some(vad) = self.vad.as_mut() else { return true };
            match vad.segments_from_samples(WhisperVadParams::default(), audio) {
                Ok(segments) => segments.num_segments() > 0,
                // A detector that fails says nothing: transcribe.
                Err(_) => true,
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn the_speech_language_becomes_whispers_code() {
            // whisper.cpp is built for AVX2/FMA; a CPU without them never calls it.
            if !super::super::super::cpu::supported() {
                return;
            }
            assert_eq!(whisper_lang("auto"), Ok(None));
            assert_eq!(whisper_lang("de-DE"), Ok(Some("de")));
            assert_eq!(whisper_lang("en"), Ok(Some("en")));
            assert_eq!(whisper_lang("xx"), Err(VoiceError::BadArgument));
        }
    }
}

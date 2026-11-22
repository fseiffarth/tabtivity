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
    /// The `voice_gpu` setting: whether to try the GPU at all (`gpu.rs`).
    pub gpu: bool,
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
    use std::ffi::{c_char, c_void, CStr};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex, Once, OnceLock};
    use std::time::{Duration, Instant};

    use app_core::sync::LockExt;
    use whisper_rs::{
        FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState, WhisperVadContext,
        WhisperVadContextParams, WhisperVadParams,
    };
    use whisper_rs_sys as sys;

    use super::super::gpu::{self, CpuReason, VoiceDevice};
    use super::super::lang::{self, LangPicker};
    use super::super::phantom;
    use super::super::vad::RATE;
    use super::super::session::{SessionConfig, Transcriber, Transcript};
    use super::super::VoiceError;
    use super::Factory;

    /// How long a loaded model stays after the last listen.
    const KEEP_LOADED: Duration = Duration::from_secs(5 * 60);

    struct Cached {
        path: PathBuf,
        gpu: bool,
        ctx: Arc<WhisperContext>,
        last_used: Instant,
    }

    static CACHE: Mutex<Option<Cached>> = Mutex::new(None);
    static REAPER: OnceLock<()> = OnceLock::new();

    /// What whisper logs about its GPU, while a load is on (`None`: it is not).
    static LOAD_LOG: Mutex<Option<Vec<String>>> = Mutex::new(None);

    /// whisper.cpp prints to stderr unless hooked; this keeps the one line
    /// that says where a load landed and drops the rest. Must not unwind.
    unsafe extern "C" fn keep_load_log(_level: sys::ggml_log_level, text: *const c_char, _user_data: *mut c_void) {
        if text.is_null() {
            return;
        }
        // SAFETY: whisper.cpp hands a NUL-terminated string, valid for the call.
        let line = unsafe { CStr::from_ptr(text) }.to_string_lossy();
        if line.contains(gpu::LOG_PREFIX) {
            if let Some(lines) = LOAD_LOG.lock_ok().as_mut() {
                lines.push(line.into_owned());
            }
        }
    }

    fn hook_log() {
        static HOOK: Once = Once::new();
        // SAFETY: `keep_load_log` neither unwinds nor keeps the text.
        HOOK.call_once(|| unsafe { whisper_rs::set_log_callback(Some(keep_load_log), std::ptr::null_mut()) });
    }

    fn context(path: &Path, use_gpu: bool) -> Result<Arc<WhisperContext>, VoiceError> {
        let mut cache = CACHE.lock_ok();
        if let Some(cached) = cache.as_mut().filter(|c| c.path == path && c.gpu == use_gpu) {
            cached.last_used = Instant::now();
            return Ok(cached.ctx.clone());
        }
        *cache = None;
        let path_str = path.to_str().ok_or(VoiceError::ModelFailed)?;
        let mut params = WhisperContextParameters::default();
        // `flash_attn` too: whisper-rs defaults it off, whisper.cpp on, and
        // the measured GPU speed is with it. The CPU's path stays as it was.
        params.use_gpu(use_gpu).flash_attn(use_gpu);
        let ctx = WhisperContext::new_with_params(path_str, params).map_err(|_| VoiceError::ModelFailed)?;
        let ctx = Arc::new(ctx);
        *cache = Some(Cached { path: path.to_path_buf(), gpu: use_gpu, ctx: ctx.clone(), last_used: Instant::now() });
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
        gpu::abandon();
    }

    /// The model and a state on `use_gpu`, and the GPU backend the load log
    /// names. A state is made per session, and it is what picks the backend,
    /// so the log is read around both.
    fn open(path: &Path, use_gpu: bool) -> Result<(Arc<WhisperContext>, WhisperState, Option<String>), VoiceError> {
        hook_log();
        if use_gpu {
            gpu::arm();
        }
        *LOAD_LOG.lock_ok() = Some(Vec::new());
        let opened = context(path, use_gpu)
            .and_then(|ctx| ctx.create_state().map(|state| (ctx, state)).map_err(|_| VoiceError::ModelFailed));
        let log = LOAD_LOG.lock_ok().take().unwrap_or_default();
        if use_gpu {
            gpu::disarm();
        }
        let (ctx, state) = opened?;
        Ok((ctx, state, gpu::backend_from_log(&log)))
    }

    /// The card's name behind ggml's backend name (`Vulkan0`).
    fn device_name(backend: &str) -> Option<String> {
        // SAFETY: the registry was built by the load that named `backend` and
        // is never torn down; a device's strings live as long as it does.
        unsafe {
            (0..sys::ggml_backend_dev_count()).find_map(|i| {
                let dev = sys::ggml_backend_dev_get(i);
                let name = sys::ggml_backend_dev_name(dev);
                if name.is_null() || CStr::from_ptr(name).to_bytes() != backend.as_bytes() {
                    return None;
                }
                let description = sys::ggml_backend_dev_description(dev);
                (!description.is_null()).then(|| CStr::from_ptr(description).to_string_lossy().into_owned())
            })
        }
    }

    /// Loads on the GPU when it may, on the CPU otherwise, and says which it
    /// got: a GPU that fails only ever costs the speed.
    fn open_on_device(factory: &Factory) -> Result<(Arc<WhisperContext>, WhisperState, VoiceDevice), VoiceError> {
        let opened = match gpu::plan(factory.gpu) {
            Err(reason) => Err(reason),
            Ok(()) => open(&factory.model, true).map_err(|_| CpuReason::NoGpu),
        };
        let (ctx, state, device) = match opened {
            Ok((ctx, state, Some(backend))) => {
                let name = device_name(&backend).or(Some(backend));
                (ctx, state, VoiceDevice::Gpu { name })
            }
            Ok((ctx, state, None)) => (ctx, state, VoiceDevice::Cpu { reason: CpuReason::NoGpu }),
            Err(reason) => {
                let (ctx, state, _) = open(&factory.model, false)?;
                (ctx, state, VoiceDevice::Cpu { reason })
            }
        };
        gpu::record(device.clone());
        Ok((ctx, state, device))
    }

    /// One language's params, built once per session and cloned per run:
    /// each setter leaks a C string, and the language/prompt setters panic
    /// on a NUL. `FullParams` is a shallow copy, so nothing is freed twice.
    struct LangParams {
        /// Whisper's code, `None` for open detection (`auto`).
        code: Option<&'static str>,
        /// Whisper's language id, for reading `lang_detect`'s vector.
        id: Option<i32>,
        final_params: FullParams<'static, 'static>,
        partial_params: FullParams<'static, 'static>,
    }

    pub struct Whisper {
        ctx: Arc<WhisperContext>,
        state: WhisperState,
        device: VoiceDevice,
        /// On the GPU with no run finished yet: the next one is under the
        /// crash guard (`gpu.rs`), the driver's first real work.
        unproven: bool,
        /// One entry per candidate language; a session without candidates
        /// has one (its language, or open detection for `auto`).
        langs: Vec<LangParams>,
        /// Whether the request had candidates: only then a final can lock
        /// and `voice:lang` goes out.
        candidates: bool,
        /// Which of `langs` to use, and when it is locked (`lang.rs`).
        picker: LangPicker,
        threads: i32,
        prompt: Option<String>,
        vad: Option<WhisperVadContext>,
        /// The flag the abort callback reads, kept alive as long as the
        /// params that point at it.
        cancel: Arc<AtomicBool>,
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
            let (ctx, state, device) = open_on_device(factory)?;
            let unproven = matches!(device, VoiceDevice::Gpu { .. });
            let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).clamp(1, 8) as i32;
            let langs: Vec<LangParams> = candidate_codes(config)?
                .into_iter()
                .map(|code| lang_params(code, threads, config.prompt.as_deref(), &cancel))
                .collect();
            let start = config
                .fallback
                .as_deref()
                .and_then(|f| whisper_lang(f).ok().flatten())
                .and_then(|f| langs.iter().position(|l| l.code == Some(f)))
                .unwrap_or(0);
            let picker = LangPicker::new(langs.len(), start);
            let vad = factory
                .vad_model
                .as_deref()
                .and_then(Path::to_str)
                .and_then(|p| WhisperVadContext::new(p, WhisperVadContextParams::default()).ok());
            let candidates = !config.langs.is_empty();
            Ok(Self { ctx, state, device, unproven, langs, candidates, picker, threads, prompt: config.prompt.clone(), vad, cancel })
        }

        /// Runs `body` under the GPU crash guard while the device is
        /// unproven. The guard's outcome is the whole body's, so a detect
        /// pass and the run after it share one `arm`/`disarm`.
        fn guarded<T>(&mut self, body: impl FnOnce(&mut Self) -> Result<T, VoiceError>) -> Result<T, VoiceError> {
            let guarded = self.unproven;
            if guarded {
                gpu::arm();
            }
            let outcome = body(self);
            if guarded {
                gpu::disarm();
                // A run cancelled early proved nothing.
                self.unproven = outcome.is_err();
            }
            outcome
        }

        /// One decode of `audio` in candidate `index`'s language.
        fn run(&mut self, audio: &[f32], partial: bool, index: usize) -> Result<Transcript, VoiceError> {
            let entry = &self.langs[index];
            let params = if partial { entry.partial_params.clone() } else { entry.final_params.clone() };
            let code = entry.code;
            self.state.full(params, audio).map_err(|_| VoiceError::ModelFailed)?;
            let mut text = String::new();
            let mut no_speech: f32 = 0.0;
            for segment in self.state.as_iter() {
                if let Ok(piece) = segment.to_str_lossy() {
                    text.push_str(&piece);
                }
                no_speech = no_speech.max(segment.no_speech_probability());
            }
            // Open detection reports what whisper heard.
            let lang = code.or_else(|| whisper_rs::get_lang_str(self.state.full_lang_id_from_state()));
            Ok(Transcript { text: text.trim().to_string(), no_speech, lang, locked: false })
        }

        /// The best candidate for `audio` and its renormalised probability;
        /// `None` when the mel or the detection fails (the caller falls back).
        fn detect(&mut self, audio: &[f32]) -> Option<(usize, f32)> {
            let ids: Vec<i32> = self.langs.iter().filter_map(|l| l.id).collect();
            if ids.len() != self.langs.len() {
                return None;
            }
            let threads = self.threads as usize;
            self.state.pcm_to_mel(audio, threads).ok()?;
            let (_, probs) = self.state.lang_detect(0, threads).ok()?;
            Some(lang::pick(&probs, &ids))
        }
    }

    /// Whisper's codes for the session's languages: the candidates, deduplicated
    /// after whisper's own aliasing, else the one `lang` (`None`: open detection).
    fn candidate_codes(config: &SessionConfig) -> Result<Vec<Option<&'static str>>, VoiceError> {
        if config.langs.is_empty() {
            return Ok(vec![whisper_lang(&config.lang)?]);
        }
        let mut codes: Vec<Option<&'static str>> = Vec::new();
        for lang in &config.langs {
            // `auto` is no candidate: it would turn the pick into a guess.
            let code = whisper_lang(lang)?.ok_or(VoiceError::BadArgument)?;
            if !codes.contains(&Some(code)) {
                codes.push(Some(code));
            }
        }
        Ok(codes)
    }

    fn lang_params(code: Option<&'static str>, threads: i32, prompt: Option<&str>, cancel: &Arc<AtomicBool>) -> LangParams {
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_n_threads(threads);
        // `None` is whisper's "auto": detect, then decode. Never
        // `set_detect_language(true)`: that means detect ONLY, and `full`
        // returns before it decodes anything (empty text every time).
        // `FullParams::new` starts on "en", so `None` must be set.
        params.set_language(code);
        if let Some(prompt) = prompt.filter(|p| !p.contains('\0')) {
            params.set_initial_prompt(prompt);
        }
        params.set_no_context(true);
        params.set_suppress_nst(true);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_special(false);
        params.set_print_timestamps(false);
        // SAFETY: the callback only reads the AtomicBool behind the
        // pointer, which `Whisper::cancel` keeps alive with the params.
        unsafe {
            params.set_abort_callback(Some(abort_when_set));
            params.set_abort_callback_user_data(Arc::as_ptr(cancel) as *mut std::ffi::c_void);
        }
        let mut partial_params = params.clone();
        partial_params.set_temperature_inc(0.0);
        partial_params.set_single_segment(true);
        let id = code.and_then(whisper_rs::get_lang_id);
        LangParams { code, id, final_params: params, partial_params }
    }

    impl Transcriber for Whisper {
        /// A partial, a seam prefix or any run that must not detect: the
        /// locked language, else the last pick, else the start language.
        fn transcribe(&mut self, audio: &[f32], partial: bool) -> Result<Transcript, VoiceError> {
            let index = self.picker.current();
            self.guarded(|me| me.run(audio, partial, index))
        }

        /// A final detects among the candidates until the session locks.
        fn transcribe_final(&mut self, audio: &[f32]) -> Result<Transcript, VoiceError> {
            let detects = self.picker.needs_detect();
            let (mut transcript, used, p) = self.guarded(|me| {
                let (index, p) = if detects {
                    me.detect(audio).unwrap_or((me.picker.current(), 0.0))
                } else {
                    (me.picker.current(), 0.0)
                };
                // `lang_detect` cannot be aborted: a final that came due or
                // an aborted session is noticed here, before `full`.
                if detects && me.cancel.load(Ordering::SeqCst) {
                    return Err(VoiceError::ModelFailed);
                }
                me.run(audio, false, index).map(|t| (t, index, p))
            })?;
            if self.candidates {
                let kept = phantom::keep(&transcript.text, transcript.no_speech, self.prompt.as_deref()).is_some();
                let speech_ms = audio.len() * 1000 / RATE as usize;
                transcript.locked = self.picker.finished(used, p, speech_ms, kept);
            }
            Ok(transcript)
        }

        fn confirm_speech(&mut self, audio: &[f32]) -> bool {
            let Some(vad) = self.vad.as_mut() else { return true };
            match vad.segments_from_samples(WhisperVadParams::default(), audio) {
                Ok(segments) => segments.num_segments() > 0,
                // A detector that fails says nothing: transcribe.
                Err(_) => true,
            }
        }

        fn device(&self) -> Option<VoiceDevice> {
            Some(self.device.clone())
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

        #[test]
        fn the_candidates_become_whispers_codes() {
            if !super::super::super::cpu::supported() {
                return;
            }
            let with = |langs: &[&str]| SessionConfig { langs: langs.iter().map(|l| l.to_string()).collect(), ..test_config("auto") };
            assert_eq!(candidate_codes(&with(&["de", "en"])), Ok(vec![Some("de"), Some("en")]));
            assert_eq!(candidate_codes(&with(&["de", "de"])), Ok(vec![Some("de")]));
            assert_eq!(candidate_codes(&with(&["de", "auto"])), Err(VoiceError::BadArgument));
            assert_eq!(candidate_codes(&with(&["de", "xx"])), Err(VoiceError::BadArgument));
            assert_eq!(candidate_codes(&test_config("de-DE")), Ok(vec![Some("de")]));
            assert_eq!(candidate_codes(&test_config("auto")), Ok(vec![None]));
        }

        /// The speech clip a real-model test transcribes: `VOICE_TEST_WAV`, a
        /// 16-bit PCM WAV (any rate or channel count) kept outside the repo.
        fn test_wav(path: &Path) -> Vec<f32> {
            let bytes = std::fs::read(path).expect("VOICE_TEST_WAV is readable");
            assert!(bytes.len() > 44 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WAVE", "a RIFF/WAVE file");
            let (mut rate, mut channels, mut bits) = (16_000u32, 1u16, 16u16);
            let mut at = 12;
            while at + 8 <= bytes.len() {
                let size = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().unwrap()) as usize;
                let body = &bytes[at + 8..(at + 8 + size).min(bytes.len())];
                match &bytes[at..at + 4] {
                    b"fmt " => {
                        channels = u16::from_le_bytes(body[2..4].try_into().unwrap());
                        rate = u32::from_le_bytes(body[4..8].try_into().unwrap());
                        bits = u16::from_le_bytes(body[14..16].try_into().unwrap());
                    }
                    b"data" => {
                        assert_eq!(bits, 16, "16-bit PCM");
                        let pcm: Vec<f32> =
                            body.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0).collect();
                        return super::super::super::resample::Resampler::new(rate, channels).push(&pcm);
                    }
                    _ => {}
                }
                at += 8 + size + (size & 1);
            }
            panic!("no data chunk in the WAV");
        }

        fn test_config(lang: &str) -> SessionConfig {
            SessionConfig {
                session: 1,
                owner: super::super::super::Owner::Tab { client: app_core::ClientId::new("main"), key: "t".into() },
                mode: super::super::super::session::ListenMode::Dictate,
                lang: lang.into(),
                langs: Vec::new(),
                fallback: None,
                end_silence_ms: 700,
                headset: false,
                prompt: None,
                barge_in: || {},
                pacing: super::super::super::session::Pacing::LIVE,
            }
        }

        /// By hand, with a real model and a speech clip: `VOICE_TEST_MODEL=<ggml
        /// file> VOICE_TEST_WAV=<clip.wav> cargo test -p tabtivity --lib --
        /// --ignored --nocapture open_detection_returns_text`. `lang: "auto"`
        /// ("Let the model guess") must decode, not only detect: it once came
        /// back empty every time.
        #[test]
        #[ignore = "needs a model file and a speech clip"]
        fn open_detection_returns_text() {
            let model = PathBuf::from(std::env::var("VOICE_TEST_MODEL").expect("VOICE_TEST_MODEL"));
            let wav = PathBuf::from(std::env::var("VOICE_TEST_WAV").expect("VOICE_TEST_WAV"));
            let audio = test_wav(&wav);
            let factory = Factory { model, vad_model: None, gpu: false };
            let mut whisper = Whisper::load(&factory, &test_config("auto"), Arc::new(AtomicBool::new(false)))
                .expect("the model loads");
            let said = whisper.transcribe(&audio, false).expect("a run");
            eprintln!("open detection heard {:?} ({:?})", said.text, said.lang);
            assert!(!said.text.is_empty(), "open detection decodes");
        }

        /// Step 4's numbers (docs/voice_language_detection_plan.md), by hand:
        /// `VOICE_TEST_MODEL=<ggml file>[:<another>] VOICE_TEST_WAVS=<dir>
        /// cargo test -p tabtivity --lib -- --ignored --nocapture
        /// language_detection_numbers`. The directory (outside the repo) holds
        /// short clips (2-4 s) named `<lang>_<anything>.wav`, such as
        /// `de_open.wav` and `en_hello.wav`; `VOICE_TEST_LANGS` (default
        /// `de,en`) is the candidate list. For each model and clip it prints
        /// what open detection heard, then the candidate pick, its p, and
        /// whether the final locked: the numbers that set `LOCK_MIN_SPEECH_MS`
        /// and `LOCK_MIN_P`. Asserts only that every candidate run decodes.
        #[test]
        #[ignore = "needs model files and speech clips"]
        fn language_detection_numbers() {
            let models: Vec<PathBuf> =
                std::env::split_paths(&std::env::var_os("VOICE_TEST_MODEL").expect("VOICE_TEST_MODEL")).collect();
            let dir = PathBuf::from(std::env::var("VOICE_TEST_WAVS").expect("VOICE_TEST_WAVS"));
            let langs: Vec<String> = std::env::var("VOICE_TEST_LANGS")
                .unwrap_or_else(|_| "de,en".into())
                .split(',')
                .map(str::to_string)
                .collect();
            let mut clips: Vec<PathBuf> = std::fs::read_dir(&dir)
                .expect("VOICE_TEST_WAVS is a directory")
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| p.extension().is_some_and(|x| x == "wav"))
                .collect();
            clips.sort();
            assert!(!clips.is_empty(), "no .wav clips in {}", dir.display());
            for model in models {
                for clip in &clips {
                    let name = clip.file_name().unwrap().to_string_lossy().into_owned();
                    let audio = test_wav(clip);
                    let factory = Factory { model: model.clone(), vad_model: None, gpu: false };
                    let cancel = Arc::new(AtomicBool::new(false));

                    let mut open = Whisper::load(&factory, &test_config("auto"), cancel.clone()).expect("open load");
                    let heard = open.transcribe_final(&audio).expect("an open run");
                    let mut config = test_config("auto");
                    config.langs = langs.clone();
                    let mut chosen = Whisper::load(&factory, &config, cancel).expect("candidate load");
                    let (index, p) = chosen.detect(&audio).unwrap_or((usize::MAX, 0.0));
                    let pick = chosen.langs.get(index).and_then(|l| l.code);
                    let last = chosen.transcribe_final(&audio).expect("a candidate run");
                    eprintln!(
                        "{} {name} ({} ms): open {:?} {:?} | pick {pick:?} p {p:.2} locked {} {:?}",
                        model.file_name().unwrap().to_string_lossy(),
                        audio.len() * 1000 / RATE as usize,
                        heard.lang,
                        heard.text,
                        last.locked,
                        last.text,
                    );
                    assert!(!last.text.is_empty(), "{name}: the candidate run decodes");
                }
            }
        }

        /// By hand, with a real model: `VOICE_TEST_MODEL=<ggml file> cargo test
        /// -p tabtivity --lib --features voice-vulkan -- --ignored --nocapture
        /// a_real_load_says_where_it_landed`. On a machine with a GPU it names
        /// the card; in a fenced tab, which has none, `no-gpu`.
        #[test]
        #[ignore = "needs a model file"]
        fn a_real_load_says_where_it_landed() {
            let model = PathBuf::from(std::env::var("VOICE_TEST_MODEL").expect("VOICE_TEST_MODEL"));
            let factory = Factory { model, vad_model: None, gpu: true };
            let (_ctx, mut state, device) = open_on_device(&factory).expect("the model loads");
            let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
            params.set_language(Some("en"));
            state.full(params, &[0.0; 16_000]).expect("a run on the device");
            eprintln!("voice device: {device:?}");
            assert!(!gpu::crashed());
        }
    }
}

//! Tauri command surface for the desktop's speech engine (`services::voice`,
//! docs/desktop_voice_plan.md step 2). Every command is `Client` class: the
//! microphone and speakers are the machine the user sits at.
//!
//! All `async` around the blocking pool: opening the audio device, reading
//! the model directory or (2c) reaching speech-dispatcher must never run on
//! the main thread. Errors are the service's kebab-case codes; the renderer
//! maps them to its own text. No `cfg` here: a build without the engine
//! answers `not-built` from the service.

use crate::services::voice::{self, ListenMode, ListenRequest, VoiceStatus};
use crate::tauri_host::Ctx;

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn voice_status() -> Result<VoiceStatus, String> {
    app_core::rt::blocking("voice", voice::status).await
}

/// The command line that installs whisper model `id` (and the voice detector
/// model) in an install tab. Only a catalog id is accepted.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn voice_model_install_script(id: String) -> Result<String, String> {
    app_core::rt::try_blocking("voice", move || voice::models::install_command(&id)).await
}

/// Start listening for the calling window's tab `tab_key`; answers the new
/// session id. Any other session stops first.
#[allow(clippy::too_many_arguments)]
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn voice_listen_start(
    ctx: Ctx,
    tab_key: String,
    model: String,
    lang: String,
    mode: ListenMode,
    pause_ms: u32,
    headset: bool,
    prompt: Option<String>,
    gpu: bool,
) -> Result<u64, String> {
    let req = ListenRequest { tab_key, model, lang, mode, pause_ms, headset, prompt, gpu };
    app_core::rt::try_blocking("voice", move || voice::listen_start(&ctx.0, req).map_err(String::from)).await
}

/// Forget that a GPU attempt crashed the app: the next listen tries it again.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn voice_gpu_retry() -> Result<(), String> {
    app_core::rt::blocking("voice", voice::gpu_retry).await
}

/// Pause (`true`) or resume the session, keeping the mic its owner's.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn voice_listen_pause(session: u64, paused: bool) -> Result<(), String> {
    app_core::rt::try_blocking("voice", move || voice::listen_pause(session, paused).map_err(String::from)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn voice_listen_stop(ctx: Ctx, session: u64) -> Result<(), String> {
    app_core::rt::blocking("voice", move || voice::listen_stop(&ctx.0, session)).await
}

/// Read `chunks` aloud as read `id`; `voice:speaking` follows it. `rate` is
/// a multiplier, 0.5–2.0; `replace` stops what is being said first.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn voice_speak(ctx: Ctx, id: String, chunks: Vec<String>, lang: String, rate: f32, replace: bool) -> Result<(), String> {
    app_core::rt::try_blocking("voice", move || voice::speak(&ctx.0, &id, &chunks, &lang, rate, replace).map_err(String::from)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn voice_speak_stop() -> Result<(), String> {
    app_core::rt::blocking("voice", voice::speak_stop).await
}

/// The system voices read-aloud can use (with step 4's voice picker).
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn voice_voices() -> Result<Vec<String>, String> {
    app_core::rt::try_blocking("voice", || voice::voices().map_err(String::from)).await
}

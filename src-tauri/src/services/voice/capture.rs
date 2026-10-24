//! The microphone: `cpal`'s default input device, resampled to 16 kHz mono in
//! the callback, with the mute gate applied there too, so audio captured
//! while the voice speaks never even reaches the session.
//!
//! Needs `voice-io`; without it [`open`] answers [`VoiceError::NotBuilt`].
//! On Linux cpal's default build has the ALSA host only, which reaches
//! PipeWire through `pipewire-alsa` (step 0). Its `default_input_device()`
//! always answers there, so "no device" shows up as the `ErrorKind` of the
//! next call, not as `None`.

use super::VoiceError;

/// Whether this build can capture at all.
pub const BUILT: bool = cfg!(feature = "voice-io");

#[cfg(feature = "voice-io")]
pub use imp::open;

#[cfg(not(feature = "voice-io"))]
pub fn open() -> Result<NoCapture, VoiceError> {
    Err(VoiceError::NotBuilt)
}

/// The capture of a build without `voice-io`; never constructed.
#[cfg(not(feature = "voice-io"))]
pub enum NoCapture {}

#[cfg(not(feature = "voice-io"))]
impl super::session::AudioSource for NoCapture {
    fn start(&mut self, _sink: std::sync::mpsc::SyncSender<super::session::Frames>) -> Result<(), VoiceError> {
        match *self {}
    }
}

/// A cpal error as the code the renderer explains. Windows' privacy switch
/// arrives as an unclassified backend error carrying `E_ACCESSDENIED`.
#[cfg_attr(not(feature = "voice-io"), allow(dead_code))]
fn classify(kind: &str, message: &str) -> VoiceError {
    match kind {
        "DeviceNotAvailable" | "HostUnavailable" => VoiceError::NoDevice,
        "PermissionDenied" => VoiceError::PermissionDenied,
        "DeviceBusy" => VoiceError::DeviceBusy,
        _ if message.contains("E_ACCESSDENIED") || message.contains("0x80070005") => VoiceError::PermissionDenied,
        _ => VoiceError::DeviceFailed,
    }
}

#[cfg(feature = "voice-io")]
mod imp {
    use std::sync::mpsc::SyncSender;
    use std::sync::{Arc, OnceLock};
    use std::time::Instant;

    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::{ErrorKind, FromSample, SampleFormat, SizedSample, StreamConfig};

    use super::super::resample::Resampler;
    use super::super::session::{AudioSource, Frames, GATE};
    use super::super::VoiceError;
    use super::classify;

    fn error(e: &cpal::Error) -> VoiceError {
        classify(&format!("{:?}", e.kind()), &e.to_string())
    }

    /// An opened, not yet playing input stream.
    pub struct Capture {
        stream: cpal::Stream,
        sink: Arc<OnceLock<SyncSender<Frames>>>,
    }

    impl AudioSource for Capture {
        fn start(&mut self, sink: SyncSender<Frames>) -> Result<(), VoiceError> {
            let _ = self.sink.set(sink);
            self.stream.play().map_err(|e| error(&e))
        }
    }

    /// Open the default input device. A missing or refused device is this
    /// call's error, so the mic button can say so at once.
    pub fn open() -> Result<Capture, VoiceError> {
        let host = cpal::default_host();
        let device = host.default_input_device().ok_or(VoiceError::NoDevice)?;
        let supported = device.default_input_config().map_err(|e| error(&e))?;
        let config: StreamConfig = supported.config();
        let sink = Arc::new(OnceLock::new());
        let stream = match supported.sample_format() {
            SampleFormat::I8 => build::<i8>(&device, config, sink.clone()),
            SampleFormat::I16 => build::<i16>(&device, config, sink.clone()),
            SampleFormat::I32 => build::<i32>(&device, config, sink.clone()),
            SampleFormat::U8 => build::<u8>(&device, config, sink.clone()),
            SampleFormat::U16 => build::<u16>(&device, config, sink.clone()),
            SampleFormat::U32 => build::<u32>(&device, config, sink.clone()),
            SampleFormat::F32 => build::<f32>(&device, config, sink.clone()),
            SampleFormat::F64 => build::<f64>(&device, config, sink.clone()),
            _ => return Err(VoiceError::DeviceFailed),
        }
        .map_err(|e| error(&e))?;
        Ok(Capture { stream, sink })
    }

    /// macOS: a mic the user refused delivers silence, not an error. This
    /// many seconds of exact zeros before any sound means "refused".
    #[cfg(target_os = "macos")]
    const DENIED_AFTER_ZERO_S: u32 = 3;

    fn build<T>(
        device: &cpal::Device,
        config: StreamConfig,
        sink: Arc<OnceLock<SyncSender<Frames>>>,
    ) -> Result<cpal::Stream, cpal::Error>
    where
        T: SizedSample,
        f32: FromSample<T>,
    {
        let mut resampler = Resampler::new(config.sample_rate, config.channels);
        let mut gap = false;
        #[cfg(target_os = "macos")]
        let (mut zeros, mut heard, zero_limit) =
            (0u64, false, config.sample_rate as u64 * config.channels as u64 * DENIED_AFTER_ZERO_S as u64);
        let error_sink = sink.clone();
        device.build_input_stream::<T, _, _>(
            config,
            move |data: &[T], _| {
                let Some(sink) = sink.get() else { return };
                if GATE.muted(Instant::now()) {
                    gap = true;
                    return;
                }
                let samples: Vec<f32> = data.iter().map(|s| s.to_sample::<f32>()).collect();
                #[cfg(target_os = "macos")]
                if !heard {
                    if samples.iter().any(|s| *s != 0.0) {
                        heard = true;
                    } else {
                        zeros += samples.len() as u64;
                        if zeros >= zero_limit {
                            heard = true;
                            let _ = sink.try_send(Frames::Failed(VoiceError::PermissionDenied));
                            return;
                        }
                    }
                }
                let out = resampler.push(&samples);
                if out.is_empty() {
                    return;
                }
                // A full channel means the session fell behind: drop rather
                // than block the audio thread.
                if sink.try_send(Frames::Audio { samples: out, after_gap: gap }).is_ok() {
                    gap = false;
                }
            },
            move |e: cpal::Error| {
                // A glitch, a reroute or a refused real-time priority is not
                // the end of the session.
                if matches!(e.kind(), ErrorKind::Xrun | ErrorKind::DeviceChanged | ErrorKind::RealtimeDenied) {
                    return;
                }
                if let Some(sink) = error_sink.get() {
                    let _ = sink.try_send(Frames::Failed(error(&e)));
                }
            },
            None,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_errors_get_their_own_codes() {
        assert_eq!(classify("DeviceNotAvailable", ""), VoiceError::NoDevice);
        assert_eq!(classify("PermissionDenied", ""), VoiceError::PermissionDenied);
        assert_eq!(classify("DeviceBusy", ""), VoiceError::DeviceBusy);
        assert_eq!(classify("BackendError", "IAudioClient::Initialize: E_ACCESSDENIED"), VoiceError::PermissionDenied);
        assert_eq!(classify("BackendError", "something else"), VoiceError::DeviceFailed);
    }
}

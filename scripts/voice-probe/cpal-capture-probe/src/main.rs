//! cpal capture probe for the desktop-voice plan, step 0.
//!
//! Opens the default input device of one cpal host (ALSA unless told
//! otherwise), prints what it found, captures for 5 s with the device's
//! default config and prints the RMS of every 100 ms window plus the total
//! frames received vs expected.
//!
//! Usage: cpal-capture-probe [--host alsa|pulseaudio|pipewire] [--secs N] [--list]
//!
//! Exit codes (one per failure class, so the result is unambiguous):
//!   0 ok, 2 bad arguments, 10 host unavailable, 11 no input device,
//!   12 permission denied, 13 device busy, 14 unsupported config,
//!   15 other build/play error, 16 stream errors during capture,
//!   17 capture ran but delivered < 90 % of the expected frames.

use std::sync::mpsc;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{
    Error, ErrorKind, FromSample, HostId, InputCallbackInfo, SampleFormat, SizedSample,
    StreamConfig, I24, U24,
};

enum Msg {
    /// One 100 ms window: (frames in window, rms over all channels).
    Window(usize, f32),
    /// The stream's error callback fired.
    StreamError(Error),
}

fn classify(err: &Error) -> (&'static str, i32) {
    match err.kind() {
        ErrorKind::HostUnavailable => ("HOST_UNAVAILABLE", 10),
        ErrorKind::DeviceNotAvailable => ("NO_DEVICE", 11),
        ErrorKind::PermissionDenied => ("PERMISSION_DENIED", 12),
        ErrorKind::DeviceBusy => ("DEVICE_BUSY", 13),
        ErrorKind::UnsupportedConfig => ("UNSUPPORTED_CONFIG", 14),
        _ => ("BUILD_ERROR", 15),
    }
}

fn fail(stage: &str, err: &Error) -> ! {
    let (class, code) = classify(err);
    eprintln!("RESULT FAIL {class} at {stage}: kind={:?}: {err}", err.kind());
    std::process::exit(code);
}

fn main() {
    let mut host_name = String::from("alsa");
    let mut secs: u64 = 5;
    let mut list = false;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--host" => host_name = args.next().unwrap_or_default(),
            "--secs" => secs = args.next().and_then(|s| s.parse().ok()).unwrap_or(5),
            "--list" => list = true,
            _ => {
                eprintln!("usage: cpal-capture-probe [--host alsa|pulseaudio|pipewire] [--secs N] [--list]");
                std::process::exit(2);
            }
        }
    }

    println!(
        "compiled-in hosts: {:?}; available now: {:?}",
        cpal::ALL_HOSTS,
        cpal::available_hosts()
    );
    let host_id: HostId = match host_name.parse() {
        Ok(id) => id,
        Err(e) => {
            eprintln!("host '{host_name}' is not compiled in (enable its cargo feature): {e}");
            std::process::exit(2);
        }
    };
    let host = cpal::host_from_id(host_id).unwrap_or_else(|e| fail("host_from_id", &e));
    println!("host: {} ({:?})", host.id().name(), host.id());

    if list {
        match host.input_devices() {
            Ok(devs) => {
                for d in devs {
                    let name = d.description().map(|x| x.name().to_owned());
                    println!("  input device: id={:?} name={:?}", d.id().map(|i| i.to_string()), name);
                }
            }
            Err(e) => println!("  input_devices() failed: kind={:?}: {e}", e.kind()),
        }
    }

    // NB: ALSA's default_input_device() always returns Some("default"); a
    // missing microphone only shows up as an error from the config/open calls
    // below, so "no device" must be classified from ErrorKind, not from None.
    let Some(device) = host.default_input_device() else {
        eprintln!("RESULT FAIL NO_DEVICE at default_input_device: host returned None");
        std::process::exit(11);
    };
    let dev_name = device
        .description()
        .map(|d| d.name().to_owned())
        .unwrap_or_else(|e| format!("<description failed: {e}>"));
    println!(
        "device: name={dev_name:?} id={:?} display={device}",
        device.id().map(|i| i.to_string())
    );

    let supported = device
        .default_input_config()
        .unwrap_or_else(|e| fail("default_input_config", &e));
    println!(
        "default input config: rate={} Hz, channels={}, format={:?}, buffer={:?}",
        supported.sample_rate(),
        supported.channels(),
        supported.sample_format(),
        supported.buffer_size()
    );
    // BufferSize::Default on purpose: Fixed(..) trips the PulseAudio host's
    // record-stream bug (max_length capped at one fragment; cpal PR #1387).
    let config: StreamConfig = supported.config();

    let (tx, rx) = mpsc::channel::<Msg>();
    let stream = match supported.sample_format() {
        SampleFormat::I8 => build::<i8>(&device, config, tx),
        SampleFormat::I16 => build::<i16>(&device, config, tx),
        SampleFormat::I24 => build::<I24>(&device, config, tx),
        SampleFormat::I32 => build::<i32>(&device, config, tx),
        SampleFormat::I64 => build::<i64>(&device, config, tx),
        SampleFormat::U8 => build::<u8>(&device, config, tx),
        SampleFormat::U16 => build::<u16>(&device, config, tx),
        SampleFormat::U24 => build::<U24>(&device, config, tx),
        SampleFormat::U32 => build::<u32>(&device, config, tx),
        SampleFormat::U64 => build::<u64>(&device, config, tx),
        SampleFormat::F32 => build::<f32>(&device, config, tx),
        SampleFormat::F64 => build::<f64>(&device, config, tx),
        other => {
            eprintln!("RESULT FAIL UNSUPPORTED_CONFIG: sample format {other:?} not handled by the probe");
            std::process::exit(14);
        }
    }
    .unwrap_or_else(|e| fail("build_input_stream", &e));

    // 0.18: streams no longer start on build; play() is required.
    let t0 = Instant::now();
    stream.play().unwrap_or_else(|e| fail("play", &e));
    match stream.buffer_size() {
        Ok(n) => println!("stream buffer: {n} frames per callback"),
        Err(e) => println!("stream buffer: unknown ({e})"),
    }
    println!("capturing {secs} s ... speak, then stay silent, to see the level move");

    let deadline = t0 + Duration::from_secs(secs);
    let mut frames: usize = 0;
    let mut stream_errors = 0usize;
    let mut first_at: Option<Duration> = None;
    let mut peak = 0f32;
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        match rx.recv_timeout(left) {
            Ok(Msg::Window(n, rms)) => {
                let at = t0.elapsed();
                first_at.get_or_insert(at);
                frames += n;
                peak = peak.max(rms);
                let db = if rms > 0.0 { 20.0 * rms.log10() } else { f32::NEG_INFINITY };
                let bar = "#".repeat(((db + 60.0).max(0.0) / 2.0) as usize);
                println!("{:>6} ms  rms {rms:.5}  {db:>6.1} dBFS  {bar}", at.as_millis());
            }
            Ok(Msg::StreamError(e)) => {
                stream_errors += 1;
                eprintln!("stream error: kind={:?}: {e}", e.kind());
            }
            Err(mpsc::RecvTimeoutError::Timeout) => break,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    drop(stream);

    let expected = supported.sample_rate() as usize * secs as usize;
    let pct = 100.0 * frames as f64 / expected as f64;
    println!(
        "first window after {:?}; frames received {frames} of ~{expected} expected ({pct:.1} %), peak rms {peak:.5}",
        first_at
    );
    if stream_errors > 0 {
        eprintln!("RESULT FAIL STREAM_ERRORS: {stream_errors} error callback(s)");
        std::process::exit(16);
    }
    if pct < 90.0 {
        eprintln!("RESULT FAIL SHORT_CAPTURE: only {pct:.1} % of the expected frames arrived");
        std::process::exit(17);
    }
    println!("RESULT OK host={} device={dev_name:?} rate={} ch={} fmt={:?} frames={pct:.1}% peak_rms={peak:.5}",
        host.id().name(), supported.sample_rate(), supported.channels(), supported.sample_format());
}

fn build<T>(
    device: &cpal::Device,
    config: StreamConfig,
    tx: mpsc::Sender<Msg>,
) -> Result<cpal::Stream, Error>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let channels = config.channels as usize;
    let window_frames = (config.sample_rate as usize / 10).max(1);
    let mut acc_frames = 0usize;
    let mut acc_sumsq = 0f64;
    let mut acc_n = 0usize;
    let tx_err = tx.clone();
    device.build_input_stream::<T, _, _>(
        config,
        move |data: &[T], _info: &InputCallbackInfo| {
            for frame in data.chunks(channels) {
                for &s in frame {
                    let v = <f32 as FromSample<T>>::from_sample_(s) as f64;
                    acc_sumsq += v * v;
                    acc_n += 1;
                }
                acc_frames += 1;
                if acc_frames == window_frames {
                    let rms = (acc_sumsq / acc_n.max(1) as f64).sqrt() as f32;
                    let _ = tx.send(Msg::Window(acc_frames, rms));
                    acc_frames = 0;
                    acc_sumsq = 0.0;
                    acc_n = 0;
                }
            }
        },
        move |e: Error| {
            let _ = tx_err.send(Msg::StreamError(e));
        },
        None,
    )
}

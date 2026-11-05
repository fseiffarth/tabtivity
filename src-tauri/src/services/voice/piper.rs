//! Natural voices for read-aloud (docs/desktop_voice_plan.md step 7): Piper
//! neural voices, chosen 2026-11-05 after the user found speech-dispatcher's
//! espeak voice on Ubuntu too poor to listen to.
//!
//! The program is the frozen MIT `rhasspy/piper` 2023.11.14-2 release (Linux
//! x86_64/aarch64, Windows x86_64; its macOS build is broken, and macOS's own
//! voices are good, so macOS keeps the OS voice). It **runs only as a child
//! process, never linked**: its phonemizer is espeak-ng (GPL). One process
//! per read: the read's chunks go to its stdin one per line, its raw 16-bit
//! mono PCM comes back on stdout as each sentence is synthesized, and
//! Tabtivity plays it itself through a `cpal` output stream — so a later echo
//! canceller can see the samples played (plan step 7's barge-in).
//!
//! Program and voices are fetched by a one-click install tab from pinned
//! URLs with embedded SHA-256s, like the whisper models (`models.rs`), into
//! `<state_dir>/voice/piper/` and `<state_dir>/voice/voices/`, never mounted
//! into a fence. Only a language code comes from the renderer.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::quote;

/// The Piper release the program comes from (MIT, archived upstream).
const PIPER_RELEASE: &str = "2023.11.14-2";

/// One OS's Piper archive.
#[derive(Debug)]
pub struct Program {
    /// `std::env::consts::OS`/`ARCH` it runs on.
    pub os: &'static str,
    pub arch: &'static str,
    pub file: &'static str,
    pub sha256: &'static str,
    pub size: u64,
}

impl Program {
    pub fn url(&self) -> String {
        format!("https://github.com/rhasspy/piper/releases/download/{PIPER_RELEASE}/{}", self.file)
    }
}

pub const PROGRAMS: &[Program] = &[
    Program {
        os: "linux",
        arch: "x86_64",
        file: "piper_linux_x86_64.tar.gz",
        sha256: "a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992",
        size: 26460462,
    },
    Program {
        os: "linux",
        arch: "aarch64",
        file: "piper_linux_aarch64.tar.gz",
        sha256: "fea0fd2d87c54dbc7078d0f878289f404bd4d6eea6e7444a77835d1537ab88eb",
        size: 26004717,
    },
    Program {
        os: "windows",
        arch: "x86_64",
        file: "piper_windows_amd64.zip",
        sha256: "f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea",
        size: 22477236,
    },
];

/// This machine's Piper archive; `None` where natural voices are not offered.
pub fn program() -> Option<&'static Program> {
    program_for(std::env::consts::OS, std::env::consts::ARCH)
}

fn program_for(os: &str, arch: &str) -> Option<&'static Program> {
    PROGRAMS.iter().find(|p| p.os == os && p.arch == arch)
}

/// One voice: a `medium` Piper voice for one app language.
#[derive(Debug)]
pub struct Voice {
    /// The primary language subtag it speaks.
    pub lang: &'static str,
    /// The file stem (`de_DE-thorsten-medium`).
    pub name: &'static str,
    /// Its folder in the voices repo.
    pub dir: &'static str,
    pub onnx_sha256: &'static str,
    pub onnx_size: u64,
    pub json_sha256: &'static str,
    pub json_size: u64,
}

impl Voice {
    pub fn onnx_file(&self) -> String {
        format!("{}.onnx", self.name)
    }

    pub fn json_file(&self) -> String {
        format!("{}.onnx.json", self.name)
    }

    fn url(&self, file: &str) -> String {
        format!("https://huggingface.co/{VOICES_REPO}/resolve/{VOICES_COMMIT}/{}/{file}", self.dir)
    }

    /// The voice's files, as (file, url, sha256, size).
    fn files(&self) -> [(String, String, &'static str, u64); 2] {
        let (json, onnx) = (self.json_file(), self.onnx_file());
        [
            (json.clone(), self.url(&json), self.json_sha256, self.json_size),
            (onnx.clone(), self.url(&onnx), self.onnx_sha256, self.onnx_size),
        ]
    }
}

const VOICES_REPO: &str = "rhasspy/piper-voices";
/// 2026-11-02: the voices repo's head when the catalog was made.
const VOICES_COMMIT: &str = "e7229f7d33a10e145e109b886d661984201ac3c4";

/// One voice per app language.
pub const VOICES: &[Voice] = &[
    Voice {
        lang: "de",
        name: "de_DE-thorsten-medium",
        dir: "de/de_DE/thorsten/medium",
        onnx_sha256: "7e64762d8e5118bb578f2eea6207e1a35a8e0c30595010b666f983fc87bb7819",
        onnx_size: 63201294,
        json_sha256: "974adee790533adb273a1ac88f49027d2a1b8f0f2cf4905954a4791e79264e85",
        json_size: 4819,
    },
    Voice {
        lang: "en",
        name: "en_US-lessac-medium",
        dir: "en/en_US/lessac/medium",
        onnx_sha256: "5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f",
        onnx_size: 63201294,
        json_sha256: "efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0",
        json_size: 4885,
    },
    Voice {
        lang: "es",
        name: "es_ES-davefx-medium",
        dir: "es/es_ES/davefx/medium",
        onnx_sha256: "6658b03b1a6c316ee4c265a9896abc1393353c2d9e1bca7d66c2c442e222a917",
        onnx_size: 63201294,
        json_sha256: "0e0dda87c732f6f38771ff274a6380d9252f327dca77aa2963d5fbdf9ec54842",
        json_size: 4817,
    },
    Voice {
        lang: "fr",
        name: "fr_FR-siwis-medium",
        dir: "fr/fr_FR/siwis/medium",
        onnx_sha256: "641d1ab097da2b81128c076810edb052b385decc8be3381814802a64a73baf99",
        onnx_size: 63201294,
        json_sha256: "39479916c2db192b5ac9764daddd0c744d83e023ad890c6976c0633ae4df8959",
        json_size: 4875,
    },
    Voice {
        lang: "it",
        name: "it_IT-paola-medium",
        dir: "it/it_IT/paola/medium",
        onnx_sha256: "6fc918b5a0ea6137382833dddfa567bffbe6a5060c02043c87192ee59c04210c",
        onnx_size: 63511038,
        json_sha256: "aea19c0a7fce29fbc359b93f10e7902854401e4c95ae2ea328ae516b15d296cf",
        json_size: 7099,
    },
];

/// The voice for a BCP 47 tag, by its primary subtag (`de-DE` → German).
pub fn voice_for(lang: &str) -> Option<&'static Voice> {
    let primary = lang.split(['-', '_']).next().unwrap_or("").to_ascii_lowercase();
    VOICES.iter().find(|v| v.lang == primary)
}

/// Whether this build can play a natural voice here at all.
pub fn offered() -> bool {
    cfg!(feature = "voice-io") && program().is_some()
}

fn voice_root() -> PathBuf {
    crate::storage::state_dir().join("voice")
}

/// The unpacked program folder (`<root>/piper/`).
fn program_dir_in(root: &Path) -> PathBuf {
    root.join("piper")
}

fn voices_dir_in(root: &Path) -> PathBuf {
    root.join("voices")
}

fn exe_name() -> &'static str {
    if cfg!(windows) {
        "piper.exe"
    } else {
        "piper"
    }
}

/// The program counts as installed when its executable and espeak-ng's data
/// are in place: the install script verified the archive before unpacking
/// and moves the folder into place last.
fn program_installed_in(root: &Path) -> bool {
    let dir = program_dir_in(root);
    dir.join(exe_name()).is_file() && dir.join("espeak-ng-data").is_dir()
}

/// A voice is installed when both its files have the catalog's exact size.
fn voice_installed_in(root: &Path, voice: &Voice) -> bool {
    let dir = voices_dir_in(root);
    let sized = |file: String, size: u64| std::fs::metadata(dir.join(file)).is_ok_and(|m| m.is_file() && m.len() == size);
    sized(voice.onnx_file(), voice.onnx_size) && sized(voice.json_file(), voice.json_size)
}

/// The installed voice for `lang`, when this machine can speak with it.
pub fn ready_for(lang: &str) -> Option<&'static Voice> {
    let root = voice_root();
    let voice = voice_for(lang)?;
    (offered() && program_installed_in(&root) && voice_installed_in(&root, voice)).then_some(voice)
}

/// One row of `voice_status`' natural-voice list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NaturalVoiceState {
    pub lang: &'static str,
    pub installed: bool,
    /// What its install still fetches (the program too, when missing).
    pub download_bytes: u64,
}

/// `voice_status`' natural-voice part.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NaturalState {
    /// Natural voices can run on this machine and build.
    pub offered: bool,
    pub voices: Vec<NaturalVoiceState>,
}

pub fn state() -> NaturalState {
    let root = voice_root();
    let program = program();
    let program_missing = match program {
        Some(p) if !program_installed_in(&root) => p.size,
        _ => 0,
    };
    NaturalState {
        offered: offered(),
        voices: VOICES
            .iter()
            .map(|v| {
                let installed = program_installed_in(&root) && voice_installed_in(&root, v);
                let voice_missing = if voice_installed_in(&root, v) { 0 } else { v.onnx_size + v.json_size };
                NaturalVoiceState { lang: v.lang, installed, download_bytes: if installed { 0 } else { program_missing + voice_missing } }
            })
            .collect(),
    }
}

/// The fetch-verify-unpack script for `lang`'s voice (and the program, when
/// missing): one script for the install tab. `windows` picks PowerShell. Each
/// hash is part of the script, checked before anything is unpacked or moved.
fn install_script(lang: &str, program: &Program, root: &Path, windows: bool) -> Option<String> {
    let voice = voice_for(lang)?;
    let root = root.to_string_lossy();
    let voices = voices_dir_in(Path::new(&*root)).to_string_lossy().into_owned();
    let mb = |size: u64| size.div_ceil(1_000_000);
    Some(if windows {
        let q = quote::powershell;
        let mut s = String::from("$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n");
        s += &format!("New-Item -ItemType Directory -Force -Path {} | Out-Null\n", q(&root));
        s += &format!("Set-Location -LiteralPath {}\n", q(&root));
        s += &format!(
            "if (Test-Path -LiteralPath (Join-Path 'piper' {exe})) {{ Write-Output '── Piper is already here ──' }} else {{\n\
             \x20 Write-Output '── Fetching Piper ({mb} MB) ──'\n\
             \x20 Invoke-WebRequest -Uri {url} -OutFile 'piper-download.part'\n\
             \x20 $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath 'piper-download.part').Hash.ToLower()\n\
             \x20 if ($actual -ne {hash}) {{ Remove-Item -LiteralPath 'piper-download.part'; throw \"checksum mismatch: $actual\" }}\n\
             \x20 Move-Item -Force -LiteralPath 'piper-download.part' -Destination 'piper-download.zip'\n\
             \x20 if (Test-Path -LiteralPath 'piper.part') {{ Remove-Item -Recurse -Force -LiteralPath 'piper.part' }}\n\
             \x20 Expand-Archive -LiteralPath 'piper-download.zip' -DestinationPath 'piper.part'\n\
             \x20 Remove-Item -LiteralPath 'piper-download.zip'\n\
             \x20 if (Test-Path -LiteralPath 'piper') {{ Remove-Item -Recurse -Force -LiteralPath 'piper' }}\n\
             \x20 Move-Item -LiteralPath (Join-Path 'piper.part' 'piper') -Destination 'piper'\n\
             \x20 Remove-Item -Recurse -Force -LiteralPath 'piper.part'\n\
             }}\n",
            exe = q(exe_name()),
            mb = mb(program.size),
            url = q(&program.url()),
            hash = q(program.sha256),
        );
        s += &format!("New-Item -ItemType Directory -Force -Path {} | Out-Null\n", q(&voices));
        s += &format!("Set-Location -LiteralPath {}\n", q(&voices));
        for (file, url, sha, size) in voice.files() {
            let name = q(&file);
            let part = q(&format!("{file}.part"));
            s += &format!(
                "if (Test-Path -LiteralPath {name}) {{ Write-Output ('── ' + {name} + ' is already here ──') }} else {{\n\
                 \x20 Write-Output ('── Fetching ' + {name} + ' ({mb} MB) ──')\n\
                 \x20 Invoke-WebRequest -Uri {url} -OutFile {part}\n\
                 \x20 $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath {part}).Hash.ToLower()\n\
                 \x20 if ($actual -ne {hash}) {{ Remove-Item -LiteralPath {part}; throw \"checksum mismatch: $actual\" }}\n\
                 \x20 Move-Item -Force -LiteralPath {part} -Destination {name}\n\
                 }}\n",
                mb = mb(size),
                url = q(&url),
                hash = q(sha),
            );
        }
        s += "Write-Output '── Natural voice ready. ──'\n";
        s
    } else {
        let q = quote::posix;
        let mut s = String::from("#!/usr/bin/env bash\nset -euo pipefail\n");
        s += &format!("mkdir -p {}\ncd {}\n", q(&root), q(&root));
        s += &format!(
            "if [ -x piper/piper ] && [ -d piper/espeak-ng-data ]; then echo '── Piper is already here ──'; else\n\
             \x20 echo '── Fetching Piper ({mb} MB) ──'\n\
             \x20 curl -fL --progress-bar -o piper-download.part {url}\n\
             \x20 echo {check} | sha256sum -c - || {{ rm -f piper-download.part; exit 1; }}\n\
             \x20 rm -rf piper.part && mkdir piper.part\n\
             \x20 tar -xzf piper-download.part -C piper.part\n\
             \x20 rm -f piper-download.part\n\
             \x20 rm -rf piper && mv piper.part/piper piper && rm -rf piper.part\n\
             fi\n",
            mb = mb(program.size),
            url = q(&program.url()),
            check = q(&format!("{}  piper-download.part", program.sha256)),
        );
        s += &format!("mkdir -p {}\ncd {}\n", q(&voices), q(&voices));
        for (file, url, sha, size) in voice.files() {
            let name = q(&file);
            let part = q(&format!("{file}.part"));
            s += &format!(
                "if [ -f {name} ]; then echo '── '{name}' is already here ──'; else\n\
                 \x20 echo '── Fetching '{name}' ({mb} MB) ──'\n\
                 \x20 curl -fL --progress-bar -o {part} {url}\n\
                 \x20 echo {check} | sha256sum -c - || {{ rm -f {part}; exit 1; }}\n\
                 \x20 mv {part} {name}\n\
                 fi\n",
                mb = mb(size),
                url = q(&url),
                check = q(&format!("{sha}  {file}.part")),
            );
        }
        s += "echo '── Natural voice ready. ──'\n";
        s
    })
}

/// Write the install script for `lang`'s voice and return the command the
/// install tab runs.
pub fn install_command(lang: &str) -> Result<String, String> {
    let program = program().ok_or_else(|| "not-built".to_string())?;
    if !offered() {
        return Err("not-built".into());
    }
    let windows = cfg!(windows);
    let root = voice_root();
    let script = install_script(lang, program, &root, windows).ok_or_else(|| "bad-argument".to_string())?;
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let path = root.join(if windows { "fetch-natural-voice.ps1" } else { "fetch-natural-voice.sh" });
    std::fs::write(&path, script).map_err(|e| e.to_string())?;
    let path = path.to_string_lossy();
    Ok(if windows {
        format!("powershell -NoProfile -ExecutionPolicy Bypass -File {}", quote::powershell(&path))
    } else {
        format!("bash {}", quote::posix(&path))
    })
}

/// Linear interpolation from the voice's rate to the device's, streaming.
/// Speech at 22.05 kHz going up to 44.1/48 kHz needs no filter.
pub struct Upsampler {
    /// Input samples per output sample.
    step: f64,
    /// Position between `prev` (0) and the next input sample (1).
    pos: f64,
    prev: f32,
}

impl Upsampler {
    pub fn new(in_rate: u32, out_rate: u32) -> Self {
        Self { step: in_rate.max(1) as f64 / out_rate.max(1) as f64, pos: 0.0, prev: 0.0 }
    }

    pub fn push(&mut self, input: &[f32], out: &mut Vec<f32>) {
        for &x in input {
            while self.pos < 1.0 {
                out.push(self.prev + (x - self.prev) * self.pos as f32);
                self.pos += self.step;
            }
            self.pos -= 1.0;
            self.prev = x;
        }
    }
}

/// Piper's raw output (16-bit little-endian mono) as floats; an odd trailing
/// byte stays in `carry` for the next block.
pub fn pcm_to_f32(bytes: &[u8], carry: &mut Option<u8>) -> Vec<f32> {
    let mut out = Vec::with_capacity(bytes.len() / 2 + 1);
    let mut iter = bytes.iter().copied();
    if let Some(lo) = carry.take() {
        match iter.next() {
            Some(hi) => out.push(i16::from_le_bytes([lo, hi]) as f32 / 32768.0),
            None => {
                *carry = Some(lo);
                return out;
            }
        }
    }
    loop {
        match (iter.next(), iter.next()) {
            (Some(lo), Some(hi)) => out.push(i16::from_le_bytes([lo, hi]) as f32 / 32768.0),
            (Some(lo), None) => {
                *carry = Some(lo);
                break;
            }
            _ => break,
        }
    }
    out
}

/// The line Piper reads for one chunk: its own line breaks would split it.
pub fn piper_line(chunk: &str) -> String {
    let mut line: String = chunk.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    line.push('\n');
    line
}

/// Kill the running Piper child, if any (a stop, or the exit teardown).
pub fn kill_current() {
    #[cfg(feature = "voice-io")]
    imp::kill_current();
}

#[cfg(feature = "voice-io")]
pub use imp::say_read;

#[cfg(feature = "voice-io")]
mod imp {
    use std::collections::VecDeque;
    use std::io::{Read, Write};
    use std::process::{Child, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use app_core::sync::LockExt;
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::{FromSample, SampleFormat, SizedSample, StreamConfig};

    use super::super::ssip::Spoken;
    use super::super::VoiceError;
    use super::{exe_name, pcm_to_f32, piper_line, program_dir_in, voice_root, voices_dir_in, Upsampler, Voice};

    /// The Piper child of the read being said: the speaker thread polls it,
    /// a stop or the exit teardown kills it.
    static CHILD: Mutex<Option<Child>> = Mutex::new(None);

    pub fn kill_current() {
        if let Some(mut child) = CHILD.lock_ok().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    /// At most this much audio waits to be played; Piper is held back
    /// (its stdout fills) beyond it.
    const MAX_BUFFERED_S: usize = 20;
    /// How long the stream stays open after the last sample left the queue.
    const DRAIN: Duration = Duration::from_millis(150);

    #[derive(Default)]
    struct Playback {
        queue: VecDeque<f32>,
        /// Samples were ever queued.
        started: bool,
    }

    /// The voice's sample rate and length scale, from its `.onnx.json`.
    fn voice_config(path: &std::path::Path) -> Result<(u32, f32), VoiceError> {
        let text = std::fs::read_to_string(path).map_err(|_| VoiceError::SpeechFailed)?;
        let json: serde_json::Value = serde_json::from_str(&text).map_err(|_| VoiceError::SpeechFailed)?;
        let rate = json["audio"]["sample_rate"].as_u64().filter(|r| (8_000..=48_000).contains(r)).ok_or(VoiceError::SpeechFailed)?;
        let scale = json["inference"]["length_scale"].as_f64().unwrap_or(1.0) as f32;
        Ok((rate as u32, scale))
    }

    fn open_output(playback: Arc<Mutex<Playback>>) -> Result<(cpal::Stream, u32), VoiceError> {
        let host = cpal::default_host();
        let device = host.default_output_device().ok_or(VoiceError::NoDevice)?;
        let supported = device.default_output_config().map_err(|_| VoiceError::DeviceFailed)?;
        let config: StreamConfig = supported.config();
        let rate = config.sample_rate;
        let stream = match supported.sample_format() {
            SampleFormat::I16 => build::<i16>(&device, config, playback),
            SampleFormat::I32 => build::<i32>(&device, config, playback),
            SampleFormat::U16 => build::<u16>(&device, config, playback),
            SampleFormat::F32 => build::<f32>(&device, config, playback),
            SampleFormat::F64 => build::<f64>(&device, config, playback),
            _ => return Err(VoiceError::DeviceFailed),
        }
        .map_err(|_| VoiceError::DeviceFailed)?;
        Ok((stream, rate))
    }

    fn build<T>(device: &cpal::Device, config: StreamConfig, playback: Arc<Mutex<Playback>>) -> Result<cpal::Stream, cpal::Error>
    where
        T: SizedSample + FromSample<f32>,
    {
        let channels = config.channels.max(1) as usize;
        device.build_output_stream::<T, _, _>(
            config,
            move |data: &mut [T], _| {
                let mut playback = playback.lock_ok();
                for frame in data.chunks_mut(channels) {
                    let sample = playback.queue.pop_front().unwrap_or(0.0);
                    for out in frame {
                        *out = T::from_sample(sample);
                    }
                }
            },
            |_e: cpal::Error| {},
            None,
        )
    }

    /// Say `chunks` in `voice`. `Ok(None)`: Piper could not be started, and
    /// nothing was said — the caller falls back to the OS voice.
    pub fn say_read(voice: &Voice, chunks: &[String], rate: f32, cancel: &AtomicBool) -> Result<Option<Spoken>, VoiceError> {
        let root = voice_root();
        let dir = program_dir_in(&root);
        let voices = voices_dir_in(&root);
        let (onnx, json) = (voices.join(voice.onnx_file()), voices.join(voice.json_file()));
        let Ok((voice_rate, length_scale)) = voice_config(&json) else { return Ok(None) };

        let playback = Arc::new(Mutex::new(Playback::default()));
        let (stream, device_rate) = open_output(playback.clone())?;

        let mut cmd = std::process::Command::new(dir.join(exe_name()));
        cmd.arg("--model")
            .arg(&onnx)
            .arg("--config")
            .arg(&json)
            .arg("--espeak_data")
            .arg(dir.join("espeak-ng-data"))
            .arg("--length_scale")
            .arg(format!("{:.3}", length_scale / rate.clamp(0.5, 2.0)))
            .arg("--output_raw")
            .arg("--quiet")
            .current_dir(&dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        crate::paths::hide_command_window(&mut cmd);
        let mut child = match cmd.spawn() {
            Ok(child) => child,
            Err(e) => {
                eprintln!("read-aloud: Piper did not start ({e}); the OS voice speaks");
                return Ok(None);
            }
        };
        let (Some(mut stdin), Some(mut stdout)) = (child.stdin.take(), child.stdout.take()) else {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(None);
        };
        kill_current();
        *CHILD.lock_ok() = Some(child);

        // Stdin from its own thread: Piper writes audio while it reads, and
        // a full stdout pipe would otherwise stall both ends.
        let text: String = chunks.iter().map(|c| piper_line(c)).collect();
        let writer = std::thread::Builder::new()
            .name("voice-piper-in".into())
            .spawn(move || {
                let _ = stdin.write_all(text.as_bytes());
            })
            .map_err(|_| VoiceError::SpeechFailed)?;

        let reader_done = Arc::new(AtomicBool::new(false));
        let reader = {
            let (playback, done) = (playback.clone(), reader_done.clone());
            let limit = MAX_BUFFERED_S * device_rate as usize;
            std::thread::Builder::new()
                .name("voice-piper-out".into())
                .spawn(move || {
                    let mut up = Upsampler::new(voice_rate, device_rate);
                    let mut carry = None;
                    let mut buf = [0u8; 8192];
                    loop {
                        while playback.lock_ok().queue.len() > limit {
                            std::thread::sleep(Duration::from_millis(50));
                        }
                        match stdout.read(&mut buf) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                let samples = pcm_to_f32(&buf[..n], &mut carry);
                                let mut out = Vec::with_capacity(samples.len() * 3);
                                up.push(&samples, &mut out);
                                let mut playback = playback.lock_ok();
                                playback.started |= !out.is_empty();
                                playback.queue.extend(out);
                            }
                        }
                    }
                    done.store(true, Ordering::SeqCst);
                })
                .map_err(|_| VoiceError::SpeechFailed)?
        };

        if stream.play().is_err() {
            kill_current();
            let _ = reader.join();
            let _ = writer.join();
            return Err(VoiceError::DeviceFailed);
        }

        let joined: String = chunks.join(" ");
        // Loading the model comes first: a few seconds on a slow machine.
        let limit = super::super::ssip::speak_limit(&joined, rate) + Duration::from_secs(20);
        let started = Instant::now();
        let outcome = loop {
            if cancel.load(Ordering::SeqCst) {
                break Ok(Spoken::Cancelled);
            }
            let finished = reader_done.load(Ordering::SeqCst);
            let (empty, heard) = {
                let p = playback.lock_ok();
                (p.queue.is_empty(), p.started)
            };
            if finished && empty {
                let failed = CHILD
                    .lock_ok()
                    .as_mut()
                    .and_then(|c| c.try_wait().ok().flatten())
                    .is_some_and(|status| !status.success());
                if failed && !heard {
                    break Err(VoiceError::SpeechFailed);
                }
                // The device still holds the callback's last buffer.
                std::thread::sleep(DRAIN);
                break Ok(Spoken::Done);
            }
            if started.elapsed() > limit {
                break Err(VoiceError::SpeechFailed);
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        kill_current();
        playback.lock_ok().queue.clear();
        drop(stream);
        let _ = reader.join();
        let _ = writer.join();
        outcome.map(Some)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_download_is_pinned() {
        let hex = |s: &str| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase());
        for p in PROGRAMS {
            assert!(hex(p.sha256) && p.size > 0, "{}", p.file);
            assert!(p.url().starts_with("https://github.com/rhasspy/piper/releases/download/2023.11.14-2/"), "{}", p.url());
        }
        assert!(VOICES_COMMIT.len() == 40 && VOICES_COMMIT.bytes().all(|b| b.is_ascii_hexdigit()));
        let mut langs: Vec<_> = VOICES.iter().map(|v| v.lang).collect();
        langs.sort();
        langs.dedup();
        assert_eq!(langs.len(), VOICES.len(), "one voice per language");
        for v in VOICES {
            assert!(hex(v.onnx_sha256) && hex(v.json_sha256) && v.onnx_size > 0 && v.json_size > 0, "{}", v.name);
            assert!(!v.name.contains(['/', '\\', '\'']), "{}", v.name);
            for (_, url, _, _) in v.files() {
                assert!(url.starts_with("https://huggingface.co/rhasspy/piper-voices/resolve/") && !url.contains("/main/"), "{url}");
            }
        }
    }

    #[test]
    fn every_app_language_has_a_voice() {
        for lang in ["de", "en", "es", "fr", "it"] {
            assert!(voice_for(lang).is_some(), "{lang}");
        }
        assert_eq!(voice_for("de-DE").unwrap().lang, "de");
        assert_eq!(voice_for("EN_us").unwrap().lang, "en");
        assert!(voice_for("auto").is_none());
        assert!(voice_for("../de").is_none());
    }

    #[test]
    fn programs_exist_where_offered() {
        assert!(program_for("linux", "x86_64").is_some());
        assert!(program_for("linux", "aarch64").is_some());
        assert!(program_for("windows", "x86_64").unwrap().file.ends_with(".zip"));
        assert!(program_for("macos", "aarch64").is_none());
    }

    fn linux() -> &'static Program {
        program_for("linux", "x86_64").unwrap()
    }

    #[test]
    fn only_a_catalog_language_gets_a_script() {
        let root = Path::new("voice");
        assert!(install_script("xx", linux(), root, false).is_none());
        assert!(install_script("../../etc/passwd", linux(), root, false).is_none());
        assert!(install_script("de", linux(), root, false).is_some());
    }

    #[test]
    fn the_bash_script_verifies_each_hash_before_unpacking_or_moving() {
        let root = if cfg!(windows) { PathBuf::from(r"C:\Users\o'brien\voice") } else { PathBuf::from("/home/o'brien/voice") };
        let script = install_script("de", linux(), &root, false).unwrap();
        assert!(script.contains(&quote::posix(&root.to_string_lossy())), "{script}");
        let check = script.find(&format!("{}  piper-download.part", linux().sha256)).unwrap();
        let untar = script.find("tar -xzf piper-download.part").unwrap();
        assert!(check < untar);
        let voice = voice_for("de").unwrap();
        for (file, url, sha, _) in voice.files() {
            assert!(script.contains(&url));
            let check = script.find(&format!("{sha}  {file}.part")).unwrap();
            let mv = script.find(&format!("mv '{file}.part' '{file}'")).unwrap();
            assert!(check < mv, "{file}");
        }
    }

    #[test]
    fn the_powershell_script_verifies_each_hash_before_unpacking_or_moving() {
        let windows = program_for("windows", "x86_64").unwrap();
        let root = Path::new(r"C:\Users\o'brien\voice");
        let script = install_script("fr", windows, root, true).unwrap();
        assert!(script.contains(r"'C:\Users\o''brien\voice'"), "{script}");
        let check = script.find(&format!("-ne '{}'", windows.sha256)).unwrap();
        let expand = script.find("Expand-Archive").unwrap();
        assert!(check < expand);
        for (file, _, sha, _) in voice_for("fr").unwrap().files() {
            let check = script.find(&format!("-ne '{sha}'")).unwrap();
            let mv = script.find(&format!("Move-Item -Force -LiteralPath '{file}.part'")).unwrap();
            assert!(check < mv, "{file}");
        }
    }

    #[test]
    fn installed_means_program_in_place_and_exact_voice_sizes() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        let voice = voice_for("it").unwrap();
        assert!(!program_installed_in(root) && !voice_installed_in(root, voice));
        let dir = program_dir_in(root);
        std::fs::create_dir_all(dir.join("espeak-ng-data")).unwrap();
        std::fs::write(dir.join(exe_name()), b"").unwrap();
        assert!(program_installed_in(root));
        let voices = voices_dir_in(root);
        std::fs::create_dir_all(&voices).unwrap();
        std::fs::write(voices.join(voice.json_file()), vec![0u8; voice.json_size as usize]).unwrap();
        std::fs::write(voices.join(voice.onnx_file()), vec![0u8; voice.onnx_size as usize - 1]).unwrap();
        assert!(!voice_installed_in(root, voice));
        std::fs::write(voices.join(voice.onnx_file()), vec![0u8; voice.onnx_size as usize]).unwrap();
        assert!(voice_installed_in(root, voice));
    }

    #[test]
    fn pcm_keeps_an_odd_byte_for_the_next_block() {
        let mut carry = None;
        let a = pcm_to_f32(&[0x00, 0x40, 0x00], &mut carry);
        assert_eq!(a, vec![0.5]);
        assert_eq!(carry, Some(0x00));
        let b = pcm_to_f32(&[0xC0], &mut carry);
        assert_eq!(b, vec![-0.5]);
        assert_eq!(carry, None);
    }

    #[test]
    fn upsampling_keeps_the_level_and_the_length() {
        let mut up = Upsampler::new(22_050, 48_000);
        let mut out = Vec::new();
        up.push(&[0.25; 22_050], &mut out);
        assert!((out.len() as i64 - 48_000).abs() < 4, "{}", out.len());
        // After the first sample's ramp up from silence, the level holds.
        assert!(out[4..].iter().all(|s| (s - 0.25).abs() < 1e-6));
        // Streaming in pieces gives the same samples.
        let (mut a, mut b) = (Upsampler::new(22_050, 44_100), Upsampler::new(22_050, 44_100));
        let input: Vec<f32> = (0..1000).map(|i| (i as f32 * 0.01).sin()).collect();
        let (mut whole, mut parts) = (Vec::new(), Vec::new());
        a.push(&input, &mut whole);
        for piece in input.chunks(37) {
            b.push(piece, &mut parts);
        }
        assert_eq!(whole, parts);
    }

    #[test]
    fn a_chunk_is_one_line() {
        assert_eq!(piper_line("Hallo\nWelt\r\n."), "Hallo Welt  .\n");
    }
}

# Desktop voice: dictation, read-aloud and hands-free in the Chat

Status: plan (2026-10-21; reviewed and amended 2026-10-22 and, before
Batch A, 2026-10-23). Step 0 partly done 2026-10-22: build, API and CI probes
recorded under step 0; the host's audio probes (`scripts/voice-probe/`) are
still for the user to run. Both of step 0's decisions are made (2026-10-23).
Step 1 and step 2a/2b in progress.

Order of work: **phase 1** (steps 0–6) ships with the OS voice, then the user
tests it live. **Phase 2** (Piper, step 7) happens only if that test finds
the OS voice not good enough. Steps 8–10 are later directions, each with its
own plan.

## Why

The phone's Focus composer has a mic button (`mobile-web/src/voiceSession.ts`,
`voiceInput.ts`), a spoken send ("go on" / German "los", `spokenSend`) and
read-aloud (`speechOutput.ts`). The desktop Chat (`TerminalReaderView` →
`ReaderComposer`) has none of it, though the 10b36095 chips already brought the
phone composer's other controls over.

The phone runs on Chrome's Web Speech API. The desktop webview cannot:
WebKitGTK (2.52 on the main host) has no `SpeechRecognition`, macOS WKWebView's
is unreliable inside an app, and only Windows WebView2 has one (online). So the
desktop gets its own speech engine in the backend, and everything above the
engine copies the phone: what is heard goes into the draft, what is sent goes
through the normal send path, and what is said is the new answer.

**Not a `claude -p` wrapper.** An earlier idea was a script that listens, pipes
each utterance into `claude -p --continue` and speaks the reply. Tabtivity
already has something better: the Chat drives the live interactive session
(`sendSteeringPrompt`, queued by the CLI while it works) and reads its stored
transcript. Voice plugs into that, so it works the same for Claude, Codex,
Gemini and every other CLI the Reader can show. It keeps the session's tools,
permission mode and history, and the terminal keeps running underneath. No
second agent process, and nothing new launched per utterance.

## Goal: hands-free navigation through Tabtivity

Voice in the Chat is the first step, not the end. The goal is to **use
Tabtivity entirely by voice**: move between projects and tabs, open mail,
calendar and the to-do board, find the agent waiting for a decision, answer it,
and hear where you are, all without touching the keyboard or mouse. Phase 1
builds the parts this needs: one microphone owner, a local recognizer, a voice
that does not hear itself, and the read-aloud seam. Step 9 sets the direction
for the navigation layer, so nothing built earlier rules it out.

The rules navigation must follow:

- **One action set: keyboard steering.** Voice drives the same
  `SteeringAction`s that keyboard steering does
  (`src/lib/shortcuts/steeringBindings.ts`: `up`/`down`/`left`/`right`, `work`,
  `back`, `jumpProject`, `slot1`–`slot9`, `nextDecision`, `nextWorking`,
  `nextDone`, `mail`, `calendar`, `todo`, `files`, `search`, `newShell`,
  `closeTab`, `agentPlan`, `agentGoal`, `agentClear`, `confirm`, …), through
  the same handler. It is not a parallel command system: a new steering
  action can be spoken as soon as it has a phrase.
- **Phrases are i18n.** Each action gets its spoken forms in the dictionaries
  (English holds every key, then de/es/fr/it). A few actions take an
  argument: "project <name>", "tab <n>", "search <words>". Whisper's initial
  prompt is seeded with the current project names and tab titles, so names
  are heard correctly.
- **Commands and dictation never mix silently.** In navigation mode an
  utterance is matched against the phrases first. In an agent's Chat composer
  it is dictation unless it starts with the command word. An utterance that
  matches nothing is said back ("didn't catch that"), never typed anywhere.
- **Voice never types into a shell.** Dictation goes only into an agent's Chat
  composer, and later into other text fields made safe for it, never into a
  plain terminal PTY.
- **Destructive actions need a spoken confirmation.** `closeTab`,
  `agentClear` and anything that `confirm` guards today wait for "confirm"
  (the existing `confirm` action).
- **It answers aloud.** After every move the voice says where you landed
  ("Project X, Claude tab, waiting for your answer"), using the facts the tab
  card and the `nextDecision`/`nextWorking` state already show. "Where am I"
  and "what's waiting" read them on request.
- **The mic follows focus, still with one owner.** In navigation mode the
  window owns the microphone rather than one Chat tab. The one-listener rule
  and the header indicator stay as they are.

## Fixed decisions (the user's, 2026-10-21)

1. **Speech-to-text: whisper.cpp built into the desktop backend**
   (`whisper-rs`), with the microphone captured natively (`cpal`), the same on
   Linux, Windows and macOS. Audio and text stay on the machine. The model is
   downloaded once, from a catalog with pinned SHA-256s, through a one-click
   install tab.
2. **Read-aloud: the OS voice first; Piper only if the OS voice is not good
   enough.** Phase 1 speaks through speech-dispatcher on Linux (already
   installed on the host) as a **child process**, `spd-say --wait` per chunk
   (decided 2026-10-22): nothing links `libspeechd`, so the binary starts on a
   machine without speech-dispatcher (read-aloud then reports itself
   unavailable), and the child's exit is the end-of-utterance signal. The
   `tts` crate is used on Windows (SAPI/WinRT) and macOS
   (AVSpeechSynthesizer) only, as a target-specific dependency.
   **Amended 2026-10-23:** step 0 found that killing `spd-say` does not stop
   the speech, so on Linux `OsTts` speaks SSIP over speech-dispatcher's
   socket itself (step 2c). Still nothing linked, still "unavailable" with no
   server, and the end-of-utterance signal is SSIP's END notification. The
   user
   tests it live. Only if they find it not good enough does
   phase 2 add Piper neural voices (step 7). Phase 1 still builds the
   `TtsEngine` seam and the voice-engine setting, so adding Piper only adds
   code and changes nothing that was built in phase 1.
3. **Phone parity plus hands-free in phase 1.** Parity: a mic toggle in the
   composer, a live "Heard:" line, the words going into the draft, the spoken
   send, and a read-aloud toggle. Hands-free: voice-activity detection sends
   after a pause, the mic opens again once the answer has been read, and a key
   interrupts it (also your voice, with a headset).
   **Send guard (decided 2026-10-22):** a hands-free send is never immediate.
   After the pause a short chime plays and a ~1.5 s cancel window opens;
   "stop" (German "stopp"), the stop key or a click on the indicator cancels
   it and leaves the draft in place. Then it sends. The spoken send ("go on")
   is deliberate and skips the window.
4. **The phone gets hands-free too, in two stages.** In phase 1 (step 5),
   a phone-only loop on Chrome's Web Speech, which needs nothing from the
   desktop work. Later (step 10), the phone acts as mic and speaker for the
   desktop engine.

Defaults chosen here (an implementer may not change them; the user may):

- **Half-duplex with the OS voice.** While Tabtivity speaks, captured audio is
  thrown away, plus a 300 ms tail, so the speakers can never dictate into the
  draft. The OS voice never shows Tabtivity the samples it plays, so there is
  nothing to feed an echo canceller. Talking over the voice (barge-in) is
  available only in **headset mode**, a setting that is off by default.
  Without it, the key interrupts. Barge-in through speakers is what Piper
  would add (step 7); the user's test decides whether that matters.
- **One listener per machine.** The mic belongs to one Chat tab at a time.
  Starting it in a second tab stops the first. A header mic indicator, in the
  status cluster like `VpnIndicator` for its machine-wide state, shows which
  tab owns the mic and stops it with one click.
- **Hands-free stays bound to its tab.** If the tab is hidden inside
  Tabtivity, the mic pauses and nothing is read aloud. When the tab is shown
  again, the answer that came meanwhile is read and the mic reopens
  (`PaneVisibleContext`). The Tabtivity window losing focus or being
  minimised does **not** pause it: working in another app is the point.
- **Hands-free is behind `useExperimental`** until it has been tested live.
  Dictation and read-aloud are not.
- **Default model: multilingual `small` q5_1** (~190 MB), good enough for
  German and English on the CPU. The catalog also offers `base` q5_1 (~60 MB,
  fast and rough) and `large-v3-turbo` q5_0 (~550 MB, best, about 2–4 s per
  sentence on the CPU). It runs on the CPU only; a GPU backend is step 8.
- **Commands are `Client` class.** The microphone and speakers belong to the
  machine the user sits at (`services::command_class`). A browser client hides
  the mic button.
- **Nothing outlives a clean quit.** The capture stream, the whisper worker
  thread and any running speech stop in the `RunEvent::Exit` teardown.

## Shape (phase 1)

```
mic ─cpal─▶ capture (16 kHz mono f32, level, mute gate)
              │
              ▼
            VAD segmenter ──▶ whisper worker ──▶ events: partial / final
                                                   │
renderer: ReaderComposer ◀────────────────────────┘
  draft += final text; "go on" or (hands-free) pause → send()  [existing path]
  Reader transcript grows → new answer at turn end → voice_speak(chunks)
                                                   │
            TtsEngine: OsTts ◀────────────────────┘ ──▶ speaking on/off → mute gate
            (SSIP to speech-dispatcher on Linux, `tts` crate on Windows/macOS)
            (phase 2 adds PiperTts behind the same seam)
```

The backend owns the audio; the renderer owns the words. The backend never
sends a prompt itself. Every send goes through `ReaderComposer.send()`, so slash
commands, subagent routing, the AI switch ⏻ and the `onSentPrompt` "sending"
state all behave exactly as for a typed prompt.

## Phase 1: OS voice

### 0. Probes (before any code lands)

- **System packages first.** The host has neither ALSA's nor
  speech-dispatcher's development files (`pkg-config` finds no `alsa`), and
  no `clang` binary. Find the exact set `cpal` (ALSA: `libasound2-dev`) and
  `whisper-rs-sys` (cmake, and libclang if its build script runs bindgen
  rather than falling back to its bundled bindings) need. Then:
  - give the user the `apt install` line to run outside the fence (the fence
    cannot install packages);
  - add the same packages to every `apt-get install` list in `ci-cd.yml`;
  - add the runtime libraries to `tauri.conf.json`'s deb `depends`
    (`libasound2`) and `speech-dispatcher` to `recommends`, never `depends`:
    it is a child process, not a link (fixed decision 2).
- **All three audio crates in all three CI jobs and in both cross-checks.**
  Pin the newest versions at least two weeks old. `scripts/ci-local.sh`'s
  macOS check uses do-nothing `cc`/`ar` stand-ins and the Windows check has
  no `cl.exe`, so a cmake build (whisper.cpp) will most likely fail there, and
  so may the platform system crates under `cpal` (CoreAudio, WASAPI) and `tts`
  (AVFoundation, WinRT). Planned answer: the cross-checks build without the
  `voice` feature, and the real Windows and macOS CI jobs build with it.
  Wire that into `ci-local.sh` (and say so in its output) rather than finding
  it at push time. Only if the real CI jobs cannot build whisper.cpp either,
  decide with the user before step 2: ship whisper.cpp's server as a wrapped
  tool instead.
- Check whether the pinned `whisper-rs` exposes whisper.cpp's Silero VAD (a
  ggml model of about 1 MB). If not, fall back to the `webrtc-vad` crate.
- Check that the pinned `whisper-rs` exposes each segment's no-speech
  probability (step 2's phantom-text filter needs it).
- `cpal` capture on PipeWire (the host), and `spd-say --wait -e` (text on
  stdin): that it returns when the audio has finished playing (not when
  synthesis ends), and
  how much output-buffer latency remains after it returns; this sets the mute
  gate's tail (300 ms is the starting value). Test each in a scratch binary
  outside the repo.
- Record the results in this file.

#### Step 0 results (2026-10-22)

Probed in a scratch crate on Ubuntu 24.04, rustc 1.99.0, outside the repo.
Nothing voice-related is linked yet; the repo changes are only the CI, deb
and cross-check wiring listed at the end.

**Pins** (newest published on or before 2026-10-08): `cpal` **0.18.2**
(2026-08-16), `whisper-rs` **0.16.0** with `whisper-rs-sys` **0.15.0**
(2026-03-12, whisper.cpp 1.8.3), `tts` **0.26.3** (2024-07-06, the latest).

**System packages (Linux).**
- Build: `libasound2-dev` (without it `alsa-sys` fails), `cmake`, a C++
  compiler (`build-essential`), `pkg-config`, and **libclang**
  (`libclang-dev`). Correction to the plan above: `whisper-rs-sys` runs
  bindgen by default and **panics** when libclang is missing; its fallback to
  the bundled bindings covers only a bindgen error after libclang loaded.
  `WHISPER_DONT_GENERATE_BINDINGS=1` forces the bundled bindings and builds
  fine on Linux and macOS, but they do not compile on Windows (they assume an
  8-byte `long`), so it is no general switch. The `clang` binary is not
  needed.
- Host line for the user, outside the fence:
  `sudo apt install libasound2-dev cmake build-essential pkg-config libclang-dev`.
- CI (ubuntu-24.04): only `libasound2-dev` is new; the runner image already
  has cmake, clang 16–18 (libclang), g++ and pkg-config. Added to all three
  `apt-get install` lists (lint, test-ubuntu, package-linux).
- Runtime (`ldd` of the scratch binary): libasound.so.2 and libstdc++ beyond
  libc/libgcc/libm. **No libgomp**: `whisper-rs-sys` sets `GGML_OPENMP=OFF`
  unless its `openmp` feature is on. The deb gains `depends: libasound2`
  (Ubuntu 24.04's `libasound2t64` provides it) and
  `recommends: speech-dispatcher`.
- Build cost: a clean release build of cpal + whisper-rs takes ~57 s on 4
  cores (~38 s for `whisper-rs-sys` alone); the stripped binary grows by
  ~1.3 MB.

**New risk: `GGML_NATIVE`.** ggml defaults to `-march=native`; on the probe
machine that compiled AVX-512 and AMX in, so a CI-built package would die
with an illegal instruction on an older CPU. `whisper-rs-sys` forwards every
`GGML_*` env var to cmake; `GGML_NATIVE=OFF` gives
`-mavx -mavx2 -mfma -mf16c -mbmi2` (x86_64). It is now set workflow-wide in
`ci-cd.yml`. Its build script does not watch `GGML_*`, so after changing one
locally run `cargo clean -p whisper-rs-sys`. Whether to require AVX2 at all
(pre-2013 x86 CPUs) is the user's call; nothing in the app checks for it yet.

**Cross-checks.** `cpal` and `tts` pass both cross-checks with the existing
stand-ins (`cpal` 0.18 uses `objc2-core-audio` on macOS, no `coreaudio-sys`
bindgen; `windows` crates are pure Rust). `whisper-rs-sys` fails both
(Windows: cmake finds no Visual Studio generator; macOS: cmake reaches the
Linux `c++`). The `DOCS_RS=1` / `WHISPER_DONT_GENERATE_BINDINGS=1` tricks
make the macOS check pass but not Windows without mingw headers and
libclang; not adopted. So, as planned, the cross-checks build without
`voice`, and **the feature wiring is inverted** relative to step 2's first
sentence:

```toml
default = ["desktop", "voice"]
voice   = ["desktop", "dep:cpal", "dep:whisper-rs", "dep:tts"]
```

`desktop` cannot be the one to turn `voice` on, or a check could not drop it
while still checking `desktop` code. `scripts/ci-local.sh` already runs the
Windows check, Windows clippy and macOS check with
`--no-default-features --features desktop` (they say so in their output);
until `voice` exists that equals the old default. `src-core`/`src-gateway`
have no features and `app-serverd` takes the library with
`default-features = false`, so the flags only touch the desktop crate;
packaging (`--features custom-protocol`) keeps the defaults and so voice.
Two refinements for step 2: split `voice-io = ["dep:cpal", "dep:tts"]` out
of `voice` so the cross-checks still check the WASAPI/CoreAudio/WinRT code
(`--features desktop,voice-io`), and register the voice commands in every
desktop build (stubs answering "unavailable" without `voice`), so
`command_class` and `commandClasses.ts` do not change with the feature set.

**Real CI runners** (decide by the first CI run in step 2): windows-2025 has
MSVC, cmake and LLVM; on Windows bindgen *must* succeed (the bundled bindings
do not compile there), so set `LIBCLANG_PATH: C:\Program Files\LLVM\bin` in
the Windows jobs if clang-sys does not find it. macos-26's Xcode supplies
libclang, the SDK and Accelerate (`ggml-blas` is always linked on macOS); the
universal DMG's `x86_64` slice is built on the arm64 runner and relies on
cmake-rs setting `CMAKE_OSX_ARCHITECTURES`, with `GGML_NATIVE=OFF` now set.

**whisper-rs 0.16.0 API.**
- Silero VAD: **yes.** In a full run: `FullParams::enable_vad`,
  `set_vad_model_path`, `set_vad_params(WhisperVadParams)`. Standalone:
  `WhisperVadContext::new(path, WhisperVadContextParams)`, `detect_speech`,
  `probabilities`, `segments_from_samples` → `WhisperVadSegments`. These take
  a whole buffer, not a stream, so `vad.rs` runs it over a sliding window (or
  uses `webrtc-vad` for the streaming start/end decision and Silero only to
  confirm a segment). The VAD model (~1 MB ggml) needs its own catalog entry.
- No-speech probability: **yes**, `WhisperSegment::no_speech_probability()`;
  also `FullParams::set_no_speech_thold`.
- `set_initial_prompt(&str)`, `set_language(Option<&str>)`,
  `set_detect_language(bool)`. `WhisperContext`, `WhisperState` and
  `WhisperVadContext` are `Send + Sync`.
- Features: default empty = CPU only; `vulkan`/`metal`/`cuda`/`openmp` stay
  off (step 8).

**`tts` 0.26.3** (Windows/macOS only, as planned: on Linux it would link
`libspeechd`).
- Windows uses the WinRT voices (`windows` 0.58, `Media.SpeechSynthesis` +
  `MediaPlayer`), not SAPI; which of the two fixed decision 2 means is
  thereby settled.
- macOS uses AVFoundation through the old `objc` 0.2 crate (not `objc2`).
- End of utterance: `on_utterance_end` is supported on both
  (`MediaEnded` / `didFinishSpeechUtterance`), so the risk "the `tts` crate
  does not report the end" does not apply.
- **Threading:** `Tts` is an `Rc<RwLock<…>>` with an unsafe `Send`/`Sync`;
  keep it on one thread. On macOS the callbacks fire only while that thread
  runs an NSRunLoop, so `OsTts` on macOS needs its own thread pumping a run
  loop (or runs on the main thread).

**cpal on PipeWire.** cpal's default build has only the ALSA host, which
reaches PipeWire through `pipewire-alsa` (the ALSA `default` PCM). Its
optional `pulseaudio` host has a record-stream bug in 0.18.2 (a
`BufferSize::Fixed` input stream drops audio after the first callback,
fixed in the `handy-cpal` fork); do not enable that feature, and use
`BufferSize::Default`.

**ALSA on the host** goes through PipeWire only with `pipewire-alsa`
installed (its `99-pipewire-default.conf` points ALSA's `default` at
PipeWire; Ubuntu 24.04's `pipewire-audio` depends on it). Without it,
`default` falls to the pulse plugin (`libasound2-plugins`) or straight to
`hw`, fighting PipeWire for the card. cpal's ALSA `default_input_device()`
always returns `Some("default")`, so "no input device" must be classified
from the `ErrorKind` of the next call (`DeviceNotAvailable`,
`PermissionDenied`, `DeviceBusy`), not from `None`. cpal 0.18 also changed
its API: one `Error`/`ErrorKind`, configs by value, explicit `play()`.

**speech-dispatcher** (Ubuntu 24.04: 0.12.0~rc2; source `src/clients/say/say.c`).
These change step 2's `OsTts`:
- `-e` **echoes stdin to stdout**: discard the child's stdout.
- Pipe mode is **line by line**: each line (≤ 16 KB, `fgets`) is its own
  `spd_say` and its own wait. Feed one chunk as one line: fold newlines to
  spaces, keep it under 16 KB.
- **A line starting with `!-!` is executed as a raw SSIP command**
  (`spd_execute_command`; verified: `!-!SET self RATE 100` changed the
  rate). Text from an agent's answer is attacker-controlled, so `OsTts`
  strips a leading `!-!` from every line, with a unit test. A line starting
  with `-` is safe (never argv).
- Pipe mode ignores a failed `spd_say`, and then `--wait` blocks forever:
  the child needs a timeout scaled to the chunk's length.
- **Killing the child does not stop the speech**: the server only marks the
  client inactive and plays its queue out (`speaking.c`; measured: the voice
  ran on 5.5 s after the kill). `spd-say -C` cancels *every* client's speech,
  a screen reader's included, and `spd-say -S` with nothing speaking spun at
  100 % CPU and never exited in 0.12.0~rc2. So `stop()` cannot be "kill the
  child". The clean answer: `OsTts` speaks SSIP itself over
  speech-dispatcher's Unix socket (`SPEAK` … `.`, `CANCEL self`, END/CANCEL
  notifications for the speaking flag), still linking nothing and still
  "unavailable" when no server answers. That replaces the `spd-say` child of
  fixed decision 2 and needs the user's OK before step 2.
- `--wait` returns on the server's END (or CANCEL) event, which is queued
  behind the audio. With the **pulse** output backend END is sent after a
  drain that subtracts the sink latency, so it may come up to one sink
  latency early; the **pipewire** backend returns once its own ring buffer
  is under 10 ms, so graph and device latency come on top. A null-sink run
  here returned 320–406 ms *after* the monitor went silent (espeak's trailing
  silence); it proves the flags, not the host's latency.

**Still to run on the host** (the user, outside the fence): the probes in
`scripts/voice-probe/` (README there: what to run and send back).
`spd_wait_probe.sh` measures the time from `--wait` returning to the sink
going silent, which sets the mute gate's tail (300 ms until then), and the
kill behaviour on real hardware. `cpal-capture-probe` captures 5 s through
cpal 0.18.2's ALSA host and checks it went through `pipewire-alsa`. It is
built and clippy-clean here; it reports `NO_DEVICE` in a container with no
sound card. Record the numbers here, then delete `scripts/voice-probe/`.

**Repo changes in step 0:** `libasound2-dev` in `ci-cd.yml`'s three apt
lists; `GGML_NATIVE: "OFF"` in its workflow env; `libasound2` in the deb's
`depends` and `speech-dispatcher` in its `recommends`
(`tauri.conf.json`); the cross-checks in `scripts/ci-local.sh` without
`voice`; the host probes in `scripts/voice-probe/`.

**Decisions made by the user (2026-10-23):**
1. `OsTts` on Linux speaks **SSIP over the socket**, not through an `spd-say`
   child (step 2c).
2. **AVX2/FMA is required** (`GGML_NATIVE=OFF`'s x86_64 baseline), with a
   runtime check that reports voice input unavailable instead of dying with
   an illegal instruction (step 2a). ggml's `GGML_CPU_ALL_VARIANTS` +
   `GGML_BACKEND_DL` (runtime-picked CPU variants, shipped as loadable
   libraries) was considered and left for step 8.

### 1. Shared voice text helpers — `shared/voice.ts`

Move these pure helpers out of `mobile-web/src/` into `shared/voice.ts`, next
to `shared/agentComposer.ts`:

- `spokenSend` and `sanitizeVoiceTranscript` (`voiceInput.ts`);
- `spokenText` and `speechChunks` (`speechOutput.ts`). `speechChunks`' `max`
  becomes a required argument: the phone's 220 is Chrome's ~15 s utterance
  cutoff, not a property of the text, so `speak()` passes it.

Leave the rest where it is. The `DictationProgress` helpers
(`readDictation`, `advanceDictation`, `settleDictation`, `dictationPreview`)
clean up Chrome's repeated, cumulative results. Whisper hands back one final
text per segment, so the desktop does not need them. `speechRecognitionError`
maps Chrome's error codes to `mobile.voice.*` keys, so it is phone-only.

`mobile-web` imports the moved helpers from `shared/voice.ts` directly (no
re-export shims), so the phone's behaviour does not change. Only their tests
move, to `src/__tests__/terminal/VoiceText.test.ts`; the tests of what stays
stay in `MobileVoiceInput.test.ts` / `MobileSpeechOutput.test.ts`. Two new
helpers, English and German only (like `spokenSend`) whatever the speech
language:

- `isStopWord(utterance)`: "stop" / "stopp" said alone, repeats allowed
  ("Stop, stop!"), on one heard segment, never the draft ("don't stop",
  "stop the server" stay text). It cancels the hands-free send window (fixed
  decision 3) and, in headset mode, interrupts the voice. Outside the window,
  plain dictation types it like any word; hands-free drops a stop-word
  segment, so it can never be sent.
- `matchOption(utterance, count)`: the 0-based option a whole utterance picks,
  else `null`. Digits, cardinals and ordinals (one…nine, eins/zwo…neun,
  first…ninth, erste[n|r|s]…), an optional article/"option"/"Nummer" before
  and "please"/"bitte" around; "to"/"too"/"for" only after "option"/"number";
  never "ein"; out of range or a longer sentence is `null`; no fuzzy match and
  no matching by the option's label (step 9 may revisit that).

### 2. Backend voice service — `src-tauri/src/services/voice/`

Split in three pieces that each land on their own (review 2026-10-23):
**2a** wiring and every command, **2b** listening, **2c** speaking. 2a and
2b are Batch A; 2c runs in Batch B beside step 3, since only step 4 needs it.
The service modules stay `AppHandle`-free: the session holds a cloned
`CoreCtx` (as `git_peer` does) and emits through it.

#### Features and gating (2a)

```toml
default  = ["desktop", "voice"]
voice-io = ["desktop", "dep:cpal", "dep:tts"]     # tts: Windows/macOS only
voice    = ["voice-io", "dep:whisper-rs"]
```

`desktop` cannot be the one to turn `voice` on, or a check could not drop it.
`scripts/ci-local.sh`'s `CROSS_FEATURES` becomes `--features
desktop,voice-io`, so the Windows/macOS cross-checks still check the
WASAPI/CoreAudio/WinRT code and the `not(voice)` stubs. No Linux gate builds
`desktop` without `voice`; the Windows clippy cross-check is what keeps the
stubs warning-free. The daemon (`--no-default-features`) compiles none of it.

- `services/mod.rs`: `#[cfg(feature = "desktop")] pub mod voice;` (the first
  gated service module). Inside it: the catalog, the CPU check, the VAD state
  machine, the phantom filter, the SSIP encoder/parser and the session state
  machine compile with plain `desktop`, so every check covers them; `capture`
  and the Windows/macOS `tts` backend need `voice-io`; `stt` and the Silero
  confirmation need `voice`, with a `not(voice)` twin answering
  `unavailable: not-built`.
- `commands/voice.rs` has no `cfg` at all: one fn per command, registered
  unconditionally in `generate_handler!` (its parser in `command_class.rs`
  rejects `#[cfg]` lines there, and `build.rs` copies a fn's `cfg` per
  signature, so cfg'd twins would emit two dispatch wrappers). `commands/
  mod.rs` gets `#[cfg(feature = "desktop")] pub mod voice;` with the usual
  "Window/OS-only (`client`)" comment, and the file joins
  `CONVERTED_COMMAND_FILES`.

#### CPU check (2a; user decision 2026-10-23)

AVX2/FMA is required (`GGML_NATIVE=OFF`'s x86_64 baseline). Before any
whisper-rs call (context, VAD context, logging hooks), `voice::cpu` checks
`is_x86_feature_detected!` for avx, avx2, fma, f16c and bmi2 under
`cfg(target_arch = "x86_64")` (a pure decision fn, unit-tested). On a
missing flag `voice_status` reports `cpu-unsupported`, `voice_listen_start`
refuses, the install card is not offered, and read-aloud still works.

#### `voice/models.rs` — the catalog (2a)

- Each entry: `id`, kind (`whisper` | `vad`), file name, Hugging Face repo
  **and** commit (`resolve/<commit>/<file>`, never `main`), pinned SHA-256,
  exact size, label code. Whisper models come from `ggerganov/whisper.cpp`,
  the Silero VAD model (~1 MB) from `ggml-org/whisper-vad`. Models live in
  `<state_dir>/voice/models/`, which is never mounted into a fence.
- "Installed" means the file exists with the catalog's exact size (the hash
  was checked before the rename).
- `install_script(id)` writes one script that fetches the chosen whisper model
  **and** the VAD model if missing: `curl` to `.part`, verify against the
  hash embedded in the script (`sha256sum -c` / `shasum -a 256 -c` /
  `Get-FileHash`), `mv`. Paths and URLs are quoted with
  `crate::quote::{posix, powershell}` (`vm.rs`' fetch script interpolates
  raw; don't copy that). The renderer runs it with `runInstallInTab`.
- Only a catalog id is ever accepted; the renderer never passes a path or a
  URL.

#### Commands, events and payloads (2a: all of them, stubs until 2b/2c)

Every command is `#[cfg_attr(feature = "desktop", tauri::command)]`, takes
`tauri_host::Ctx`, and is `async` around `app_core::rt::blocking` (a sync
command runs on the GTK main thread; opening ALSA, loading a model or
connecting SSIP there would freeze the window). Each gets a `Client` row in
`command_class`; regenerate `src/lib/transport/commandClasses.ts` once, in
2a.

- `voice_status` → `{ cpu, models: [{id, kind, installed, sizeBytes}],
  defaultModel, listen: unavailable-reason | null, speak: unavailable-reason
  | null, session: Session | null }`. The active session lets a reloaded
  window's indicator recover.
- `voice_model_install_script(id)` → the command line for the install tab.
- `voice_listen_start({ model, lang, mode: "dictate" | "handsFree",
  pauseMs, headset, prompt? })` → `{ session }`. Each argument is checked
  against its range (`lang` an allowlisted BCP-47-ish tag or `auto`,
  `pauseMs` 800–4000, `prompt` stripped of control bytes and ≤ 500 chars).
  The owner is the calling window (`ctx.caller`, never the payload) plus a
  tab key; a new start stops the old session.
- `voice_listen_pause({ session, paused })`: keeps ownership (a hidden tab,
  the mic closed while the agent works).
- `voice_listen_stop({ session })`.
- `voice_speak({ id, chunks, lang, rate, replace })`: ≤ 200 chunks of ≤ 1000
  characters; `rate` a multiplier 0.5–2.0 that each backend maps (SSIP
  −100…100, WinRT 0.5–6, AVFoundation 0.1–2). `voice_speak_stop`.
  `voice_voices`. (2c.)
- Events, names as `const`s in the scope:verb style the tree uses (no
  `x://y`): `voice:level`, `voice:vad`, `voice:partial`, `voice:final`,
  `voice:state`, `voice:speaking`, `voice:owner`, `voice:error`. Every
  payload is a camelCase serde struct carrying the monotonic `session` id;
  `vad`/`partial`/`final` also carry `segment`. `level`, `vad`, `partial` and
  `final` go only to the owner's window (`emit_to`; `level` ≤ 20 Hz); `state`,
  `owner` and `speaking` are broadcast for the header indicator.
  - `vad`: `{session, segment, state: "start" | "end"}`, so step 4's send
    guard knows a segment is open before its text exists.
  - `final`: `{session, segment, text}`, empty when dropped.
  - `state`: `"preparing" | "listening" | "paused" | "stopped"` plus a
    reason (`preparing` covers the lazy model load).
  - `speaking`: `{readId, state: "started" | "done" | "stopped" | "failed"}`;
    `done` is sent after the mute gate's tail.
  - A final that arrives for an older session is ignored by the renderer.
- Errors and unavailable reasons are one closed Rust enum serialised as
  kebab-case codes (`no-device`, `permission-denied`, `device-busy`,
  `model-missing`, `cpu-unsupported`, `not-built`, `no-speech-server`, …).
  TS keeps a complete `Record<VoiceErrorCode, TranslationKey>` (as
  `REASON_KEYS` in `src/lib/browser.ts`), so a missing key fails `tsc`; no
  i18n key crosses from Rust.
- Lifecycle: the session stops when its owner window is destroyed
  (`WindowEvent::Destroyed`) or reloads (`Builder::on_page_load`), and in
  `services::voice::stop_for_exit()` beside `api_proxy::stop_for_exit()`:
  set the abort flag, close the stream, SSIP `CANCEL self`, join ≤ 500 ms,
  then detach.
- macOS (the build is hardened): `com.apple.security.device.audio-input` in
  `src-tauri/entitlements.plist`, and a new `Info.plist` with an
  `NSMicrophoneUsageDescription` that does not name the app (or it needs a
  `brand-check.sh` row).

#### Listening (2b)

- `voice/capture.rs` (`voice-io`): the `cpal` default input device
  (`BufferSize::Default`, ALSA host only), downmixed and resampled to 16 kHz
  mono by a small tested pure-Rust FIR decimator, into a ring buffer. The
  mute gate is applied inside the callback. `default_input_device()` always
  answers on ALSA, so errors are classified from the next call's `ErrorKind`
  (`DeviceNotAvailable`, `PermissionDenied`, `DeviceBusy`); Windows privacy
  denial arrives as `BackendError` (`E_ACCESSDENIED`) and macOS TCC denial
  often as pure silence, so a few seconds of exact zeros reports
  `permission-denied`. Xruns and device changes are not fatal. An RMS level
  on the phone meter's scale.
- `voice/vad.rs`: a pure energy + hysteresis state machine (start threshold
  over an adaptive noise floor, ≥ 250 ms of speech before a segment opens, so
  the chime cannot open one; end-of-speech silence 700 ms for dictation, the
  hands-free pause for hands-free; 30 s maximum segment, whisper's window).
  Unit-tested on synthetic tone/silence buffers. When the Silero model is
  installed, it confirms a finished segment (whole-buffer API) before it is
  transcribed; no `webrtc-vad`.
- `voice/stt.rs` (`voice`): one worker thread holding the `WhisperContext`,
  loaded lazily, dropped 5 minutes after the last listen.
  - `FullParams` is built once per session and cloned: its setters leak
    (`CString::into_raw`) and `set_language` / `set_initial_prompt` panic on a
    NUL byte. `no_context`, `suppress_nst`, and for partials
    `temperature_inc = 0`. Text is read lossily.
  - Each finished segment comes back as `final` text, or an empty `final` when
    dropped. A due final aborts a running partial through the abort callback.
  - Partials: about once a second while a segment is open, over only its last
    ~5 s, skipped while one is still running.
  - Language: the desktop speech language (step 3); auto-detect only if picked
    explicitly. An optional initial prompt for step 9's name hints.
- **Phantom text filter** (pure, `fn(text, no_speech, lang, prompt)`): drop a
  segment when whisper's per-window no-speech probability is high, when its
  whole text is on a short per-language list of known phantom lines ("Thank
  you for watching.", "Untertitel von …"), when it is only bracketed
  (`[BLANK_AUDIO]`, `(Musik)`), or when it echoes the initial prompt.
- `voice/mod.rs`: one `VoiceSession { session, owner, mode, lang, headset,
  paused }`, generic over `AudioSource` / `Transcriber` / `TtsEngine` so the
  owner handover, pause, mute gate and tail are tested with fakes, without a
  device. `owner` is an enum: `Tab { client, key }` now, `Window` for step 9.

#### Speaking (2c, Batch B)

`voice/tts.rs`: `trait TtsEngine { speak(chunk, lang, rate), stop(),
voices() }`, a chunk queue that `stop()` empties, and a `speaking` flag set
before the first chunk, held across chunks, and dropped after the last end
plus the 300 ms tail, which drives the capture's mute gate.

- **Linux: SSIP over speech-dispatcher's socket** (user decision 2026-10-23,
  replacing the `spd-say` child: killing it did not stop the speech, and `-C`
  silences every client, a screen reader's too). Still links nothing.
  - Socket: `SPEECHD_ADDRESS` only when it is `unix_socket:<absolute path>`,
    else `$XDG_RUNTIME_DIR/speech-dispatcher/speechd.sock`. Ubuntu 24.04
    socket-activates the server (`speech-dispatcher.socket`, enabled by
    default; `-t 0`, it never exits). Only on ENOENT/ECONNREFUSED run
    `speech-dispatcher --spawn` (argv, no shell, ~3 s limit, one retry), as
    libspeechd does; a server we started is not ours to stop. The
    `CLIENT_NAME` handshake has a ~2 s read timeout (systemd accepts the
    connection even when the service fails); after it, `no-speech-server`.
  - `SET self CLIENT_NAME` from `app_slug!`; `PRIORITY text` (yields to a
    screen reader's `message`/`important`); `LANGUAGE` from an allowlist;
    `RATE` an integer −100…100; `SYNTHESIS_VOICE` only a name `LIST
    SYNTHESIS_VOICES` returned; `SSML_MODE` off.
  - `SPEAK` body: control characters (C0/C1, CR and LF included) folded so a
    chunk is one line, a leading `.` doubled (a lone `.` would end the
    message and run the rest as commands), a byte cap, then `\r\n.\r\n`.
  - `NOTIFICATION END on` / `CANCEL on`; a reader thread separates 7xx events
    from replies and maps the message id from `225-`. One chunk in flight,
    with a timeout scaled to its length. A CANCEL we did not send means
    "interrupted" (`speaking: stopped`).
  - Tests against a fake `UnixListener` server, with chunks `"."`, `".x"` and
    `"\r\n.\r\nQUIT"`.
- **Windows/macOS: the `tts` crate** (`cfg(not(target_os = "linux"))`) on its
  own thread (MTA on Windows; a run loop on macOS, where the callbacks fire
  only while it runs). Its callbacks run while the crate holds its locks, so
  they only send on a channel; WinRT's `stop()` fires only `utterance_stop`,
  so `OsTts` reports `stopped` itself; macOS `voice()` is `unimplemented!()`
  and is never called.
- No server, or no backend, means read-aloud is unavailable (`voice_status`),
  never a crash.

`docs/third_party_update_checklist.md`: a numbered "Voice" section for
whisper.cpp / `whisper-rs`, the catalog's commits and hashes, `cpal`, `tts`
and the SSIP subset used. File-map rows land with the files (steps 1 and 2),
not in step 6.

### 3. Desktop dictation in the Chat

- `src/lib/voice/desktopVoice.ts` — the renderer side of the session:
  - Start, stop, event subscription and owner tracking.
  - Shaped like the phone's `DictationSession` (`onStart`, `onResult`,
    `onLevel`, `onError`, `onEnd`), so `ReaderComposer` can use the phone's
    draft logic (`Terminal.tsx`) through the shared helpers.
  - A small Zustand slice for the owner tab and its state, read by the header
    indicator.
- `ReaderComposer` (`TerminalReaderView.tsx`):
  - A mic button next to Send, copied from the phone's composer mic with the
    same states: off, listening with a level ring, preparing, error.
  - The "Heard:" strip goes under the chip row.
  - A final segment is appended to the draft, sanitized, through `editDraft`
    so undo works.
  - If the draft ends in the spoken send, `send()` is called without those
    words.
  - The ✕ / clear settles the dictation, as on the phone.
- First use with no model installed: the button opens a small card ("Install
  speech model · small, 190 MB") that opens the install tab. The card uses the
  shared dialog/menu scheme (portaled, so it sets an explicit `color`).
- Settings → Voice, a new i18n'd section:
  - model;
  - voice engine (phase 1 lists only "System voice") and the system voice
    with its rate;
  - speech language: `auto` = the UI language, and one setting covers both
    directions, as in `mobile-web/src/speechLang.ts`;
  - headset mode;
  - the hands-free pause length.
- Rebindable shortcuts in `src/lib/shortcuts/shortcuts.ts` (`SHORTCUT_DEFS`,
  next to `AGENT_TAB_ACTIONS`): toggle mic and stop speaking. The stop key
  also cancels the hands-free send window. Pick defaults that do not collide
  with the `terminal.reader` keys or other chords, and check the shortcut
  tables. (`steeringBindings.ts` holds only steering mode's single keys; a
  steering action for the mic can come with step 9.)
- i18n: `terminal.reader.voice.*` keys in English plus de/es/fr/it. Reuse the
  phone's wording where the text is identical.
- `UntestedTag` + `src/lib/untested.ts` rows: `terminal.reader.voice.dictate`,
  `.spokenSend`, `.install`, `.indicator`.

### 4. Read-aloud and the hands-free loop

- **Read-aloud.** A toggle in the Chat's menu, as the phone's
  `focusReadAloud`.
  - When the turn ends, it speaks `spokenText` of the new answer in
    `speechChunks` through `voice_speak`. "Turn ended" is the agent's
    hook-reported `AgentTurnState` (`noteAgentTurn` in `stores/activity.ts`:
    `done` or `decision`) plus the new answer in the Reader's transcript.
    Only for an agent without turn hooks does it fall back to `busyByTab`
    going idle. That flag comes from terminal output, so a quiet long tool
    call looks idle.
  - Popout windows get no turn state (`noteAgentTurn` returns early when
    `isDetachedWindow()`). A Chat tab in a popout either gets that state
    forwarded or offers no read-aloud there; decide when implementing and
    note it.
  - It follows the phone's rule that only a short new tail is news
    (`Terminal.tsx`, around line 2367), and never reads while the user is
    dictating.
  - The shortcut, the indicator or any send stops it.
- **Hands-free** (`useExperimental`): mode `HandsFree` on the same session.
  - The end-of-speech pause sends the draft; the spoken send still works too.
    The pause counts only once the last segment has settled (its `final`, or
    its empty `final` when dropped, has arrived) and no new speech started.
    A timer alone would race the transcription and send before the last words
    reach the draft. An empty draft never sends.
  - The pause opens the send guard (fixed decision 3): a chime, then a ~1.5 s
    cancel window in which "stop", the stop key or the indicator cancels.
    The mic stays open during the window, so the stop word can be heard.
    A spoken "stop" takes ~0.4 s, then the end silence, then ~1 s of
    whisper, so it cannot settle inside 1.5 s: the window holds while a
    segment is open (`voice:vad` start) or unsettled, and decides on that
    segment's `final`: a stop word cancels, other text joins the draft and
    the pause starts again.
  - Once the answer has been read, or right away if read-aloud is off, the mic
    opens again. "Answered" means the turn ended (above), not the first
    answer entry: an agent that says something and then runs a tool is still
    working.
  - A question card in the Reader (`terminal-reader-question`) is read out,
    and an answer like "one" or "option two" picks it.
  - In headset mode, speech heard while it speaks → `voice_speak_stop`, and
    it listens. Otherwise only the key interrupts.
  - Interrupting stops the *voice*, never the agent's turn; the CLI's own Esc
    stays the way to stop the turn.
- Untested rows: `terminal.reader.voice.readAloud`, `.handsFree`,
  `.headsetBargeIn`.

### 5. Phone hands-free on Chrome's speech (`mobile-web`)

Today, dictation and read-aloud exclude each other on the phone: read-aloud
is silent while you dictate, and starting the mic stops any speech
(`mobile-web/src/screens/Terminal.tsx`, the read-aloud effect around line
2367). Nothing reopens the mic after an answer. This step adds the loop:

- A hands-free toggle in the Focus menu next to read-aloud, behind the phone's
  experimental flag, using the same `shared/voice.ts` helpers as the desktop
  (step 1).
- Pause-to-send: a silence timer on the `DictationSession` calls
  `submitDraftRef.current` when no new result has come for the hands-free
  pause (same setting range as the desktop), through the same send guard as
  the desktop: chime, ~1.5 s cancel window, "stop" or a tap cancels.
  "go on"/"los" still works and skips the window.
- After the send, the session stops with `stop()`, not `abort()`, so the last
  words are kept.
- Today the phone reads each answer entry as soon as it lands in the
  transcript (`Terminal.tsx`, the read-aloud effect), not at the end of the
  turn. That stays for plain read-aloud. Hands-free also needs the end of the
  turn before it reopens the mic. Take it from the per-tab `AgentStatus` the
  phone bridge already serves (`mobile-web/src/api.ts`: `working` → `done`,
  `question` or `interrupted`). When the turn has ended **and** the last
  chunk's utterance has ended, the mic opens again (a new `startDictation`).
  With read-aloud off, it reopens as soon as the turn ends.
- A question card is read out and picked by voice (step 1's matcher).
- Interrupting is a tap on the large listening/speaking surface, or the stop
  word. The mic stays closed while the phone speaks, because Chrome's
  recognizer is not echo-cancelled against `speechSynthesis`.
- Probe whether a headset's media button reaches the page through the Media
  Session API. If it does, it toggles talk/stop.
- Limits, shown in the toggle's hint: the screen stays on and the page must
  stay open. Android takes the mic from a hidden page; the wake lock is
  already held while dictating. Working from your pocket would need a native
  app, which is out of scope.
- i18n `mobile.voice.handsFree*` keys; untested rows `mobile.voice.handsFree`
  and `mobile.voice.handsFreeQuestion`. Rebuild with `npm run mobile:bundle`.

### 6. Docs

- `docs/context/voice.md`: why the engine sits in the backend, why the OS
  voice is half-duplex, the one-listener rule, why there is no `claude -p`,
  and the navigation goal with its rules (above). Add it to the list in
  `AGENTS.md`'s "Where to look".
- File map rows land with their files (steps 1–5); step 6 checks them.
- Help docs topic (the `tabtivity-help` corpus): "Talking to an agent".
- A `todo/` entry with the 🖐️ manual boxes and per-platform ✅/❌ pairs.

### Test gate: the user tests phase 1

The user tests phase 1 live in the frozen dev build after it is committed
(agents never start Tabtivity). The steps are under Verification below. The
question for the gate: **is the OS voice good enough?** Two things decide it:
how it sounds, especially speech-dispatcher's espeak default on Linux, and
whether interrupting by key or with a headset is enough for hands-free. If
both are fine, phase 2 is dropped. If either is not, phase 2 starts.

## Phase 2: Piper, only if the OS voice is not good enough

### 7. Piper voices and barge-in through speakers

- **Probe first.** The MIT-licensed `rhasspy/piper` was archived in October
  2025, and its last standalone binaries get no fixes. The active
  `OHF-Voice/piper1-gpl` is GPL-3 and mainly a Python package. Check which
  one ships something usable for Linux x86_64/aarch64, Windows and macOS
  arm64 that streams raw PCM to stdout, then pick it with the user: the
  frozen MIT binary, or piper1-gpl installed into Tabtivity's own tool root
  (`services::agent_install` paths) by an install tab. Either way it **runs
  only as a child process, never linked**: piper1-gpl and its phonemizer
  (espeak-ng) are GPL.
- **Catalog.** The step 2 catalog gains the Piper program and one `medium`
  voice per app language (~60 MB each, `.onnx` + `.onnx.json`, both hashed),
  stored in `<state_dir>/voice/voices/`.
- **`PiperTts`**, behind the existing `TtsEngine` seam:
  - It spawns Piper (path from the tool root, never from the renderer),
    feeds it text on stdin and reads raw PCM from stdout.
  - It plays the PCM itself through a `cpal` output stream.
  - The child joins the `RunEvent::Exit` teardown and is killed on `stop()`.
  - It falls back to the OS voice when no Piper voice is installed for the
    language or the program fails to start. The fallback is reported once
    through `voice:error`, never on every chunk.
- **Echo cancellation.** `capture.rs` runs `webrtc-audio-processing` (echo
  cancellation and noise suppression) against the frames Piper plays, so you
  can talk over Piper through the speakers. Until that has been tested live,
  speech heard during playback must also pass a stricter VAD threshold before
  it counts as barge-in. Probe that the crate builds on the three CI OSes and
  in the cross-checks, like whisper.cpp in step 0.
- **UI.** The voice-engine setting lists Piper and the installed voices. The
  read-aloud toggle offers an install card ("Install natural voice · German,
  60 MB") the first time; the OS voice speaks until then.
- Rows in `docs/third_party_update_checklist.md` for Piper, its voices and
  `webrtc-audio-processing`; an untested row `terminal.reader.voice.piper`
  and `.speakerBargeIn`.

## Later (each its own plan run)

### 8. GPU and more voices

- A GPU backend for whisper.cpp: Vulkan on Linux/Windows, Metal on macOS.
- More voices per language and a speaking rate that follows the Settings
  slider, for whichever engines exist by then.

### 9. Hands-free navigation

Written up in `docs/voice_navigation_plan.md` (2026-10-22), with the user's
decisions: push-to-talk, command word inside a dictating Chat, a short
landing line, main window plus overlays. It starts once phase 1 has been
tested live. That plan replaces the sketch below, which is kept for history.
The shape it started from:

- `src/lib/voice/voiceCommands.ts`: a pure matcher from an utterance to a
  `SteeringAction` plus an argument. It uses the i18n phrase table and fuzzy
  matching for project and tab names, and is unit-tested per language.
- The dispatch goes through `stores/keyboardSteering.ts`'s existing action
  handling, so voice and keys can never drift apart. A test asserts that every
  `SteeringAction` has a phrase, or is explicitly listed as not spoken.
- Spoken feedback goes through the same `TtsEngine` queue as read-aloud; a
  navigation answer cuts in front of a long read.
- Decisions to ask the user then: the command word, whether navigation is
  always on or push-to-talk, how far it reaches beyond the main window (mail
  and calendar overlays, popouts, the phone), and how much it says back.

### 10. The phone as mic and speaker for the desktop engine

- The phone captures with `getUserMedia({ echoCancellation: true })`. With no
  Web Speech recognizer alongside it, this avoids the two-captures problem
  noted in `voiceSession.ts`.
- It streams 16 kHz PCM over the phone link to the desktop's VAD and whisper,
  and gets `partial`/`final` events back. The phone gets the desktop's
  recognition quality even with the OS voice.
- Speaking:
  - With the OS voice only, the phone keeps its own `speechSynthesis`, since
    the desktop's system voice never hands out samples.
  - If phase 2 happened, the desktop's Piper synthesizes the answer and the
    phone plays the PCM through Web Audio. Chrome's echo canceller then
    removes it, so you can talk over the voice on the phone speaker. Probe
    this on the user's phone first.
- This is a new audio route in `services::mobile_control`:
  - authenticated like every phone call, and bounded in rate and size;
  - it streams to exactly one session owner (the one-listener rule spans
    desktop and phone);
  - no ids or paths cross the browser API;
  - it needs its own security pass against `docs/threat_model.md`.
- When the desktop is unreachable, it falls back to step 5's Chrome speech.

## Verification

- **Unit tests:**
  - VAD segmenter on synthetic buffers; the resampler; the CPU decision.
  - The model catalog: ids are unique, hashes are 64 hex characters, URLs name
    a commit, and the install script verifies the embedded hash before `mv`,
    quoting every path, per OS (`cfg!(windows)` literals).
  - The session (with fake source, transcriber and voice): single owner,
    handover, pause, stale-session events, the mute gate and its tail.
  - The shared helpers' tests pass unchanged after the move; the stop-word
    and option matchers.
  - The phantom-text filter: high no-speech probability and each listed
    phantom line are dropped (as an empty `final`); real speech that merely
    contains such words is kept.
  - `OsTts` on Linux against a fake SSIP server: a chunk that is `.`, `.x` or
    holds `\r\n.\r\nQUIT` is spoken as text and never ends the message;
    `stop()` sends `CANCEL self` and empties the queue; END/CANCEL drive the
    speaking flag.
  - `ReaderComposer` with a mocked `voice:*` stream: final → draft; "go on" →
    `send` once without the words; hands-free pause → cancel window → send;
    "stop" in the window → no send, draft kept; the pause never sends before
    the last segment settled or with an empty draft; read-aloud only on the
    hook's `done`/`decision` (busy → idle only without hooks), never while
    listening, and the mic not reopened after a mid-turn answer entry.
  - The phone loop with mocked recognition and synthesis: send → mic closed →
    answer spoken → `AgentStatus` `done` → mic reopened; an answer entry
    while still `working` does not reopen it.
- **Gates:** `scripts/gates.sh` for the touched set, then `--all` and
  `scripts/ci-local.sh` before any push. Read its Windows/macOS cross-check
  and daemon `ldd` lines in particular (step 0's risk).
- **Live, phase 1, by the user** in the frozen dev build:
  1. Chat tab → mic → install card → the install tab finishes and verifies.
  2. Dictate two sentences in German, then in English: the words appear in
     the draft, and "Heard:" updates while you speak.
  3. End with "go on" / "los": it sends without the words; "was ist los"
     stays text.
  4. Read-aloud on: the OS voice speaks the answer once the turn ends, code
     blocks are announced rather than read out, and the mic hears nothing of
     it. **Judge the voice: good enough, or is Piper needed?**
  5. Hands-free (Experimental): ask, pause, the chime plays, the prompt is
     sent after the cancel window; once more, say "stop" in the window and
     the draft stays unsent. The answer is read, the mic reopens; it stays
     closed while the agent is still running tools. Sit silent in a noisy
     room for a minute: nothing is sent. The key interrupts the voice and
     the agent keeps going. With a headset and headset mode on, talking over
     the voice stops it.
     **Judge: is interrupting like this enough?**
  6. Start the mic in a second tab: the first stops, and the header indicator
     follows.
  7. Phone: hands-free in Focus: ask, pause, hear the answer, the mic
     reopens; a tap interrupts.
  8. Quit: no speech process or audio stream is left behind.
- **Live, phase 2** (if it happens): install the German Piper voice and
  check the next answer uses it. Through speakers with no headset, talking
  over Piper stops it, and your words go into the next prompt, not its own.

## Organisation (if run as plan + implement + review)

- Step 0 runs first, in the main loop.
- Batch A: step 1 (frontend, small) ∥ step 2a then 2b (backend, one
  implementer: build-heavy, alone on cargo). 2a goes to a scratch branch
  first, so the real Windows/macOS jobs build whisper-rs-sys (libclang on
  windows-2025, the macOS universal slice) before anything reaches `develop`;
  if they cannot, decide with the user (step 0's fallback) before 2b.
- Batch B, in parallel: step 3 (needs 2a's commands and payloads) ∥ step 2c
  (speaking) ∥ step 5 (phone, needs only step 1).
- Batch C: step 4. Batch D: step 6. Then stop for the test gate.
- Step 7 is its own run after the gate, only if needed. Steps 8–10 are later,
  separate plan runs.
- One reviewer per batch, checking against the fixed decisions above, and a
  final review across the whole diff. At most 2 cargo-running agents at once
  (the `/tmp` tmpfs).

## Risks

- whisper.cpp's C++ build, and the platform audio crates, in the cross-checks
  and on all three CI runners (step 0), plus added build time for the
  desktop binary. The cross-checks are expected to run without `voice`, so
  Windows/macOS voice code is checked only by the real CI jobs.
- New system packages (ALSA development files, libclang) on the host,
  in CI and in the deb's dependencies (step 0). The host's need the user,
  outside the fence.
- Whisper's phantom text on noise. The filter (step 2) and the send guard
  (decision 3) cover it; the noisy-room live test confirms it.
- CPU load: `small` takes several cores for about a second per sentence, and
  partials cost more. Partials are skipped while one is still running, and a
  setting turns them off.
- speech-dispatcher's default espeak voice may sound too robotic. That is
  what the test gate is for; Piper is the answer if so.
- With the OS voice, hands-free without a headset depends entirely on the
  mute gate. The 300 ms tail covers audio still buffered in the output device
  after the `speaking` flag drops; the live test must confirm it.
- If speech-dispatcher's END arrives before the audio has drained (step 0:
  up to one sink latency early with the pulse backend), the mute gate's tail
  grows to cover it. (Step 0 found the `tts` crate does report
  the end of an utterance on Windows and macOS.)
- Phone hands-free needs the screen on and the page open, which is a hard
  limit of a web app on Android.
- Phase 2 only: Piper's packaging is in flux (MIT binaries frozen, GPL line
  Python-first), and echo cancellation through laptop speakers can let a loud
  voice leak through as a false barge-in.

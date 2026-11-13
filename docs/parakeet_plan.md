# Parakeet: a second local speech engine

Status: plan only (2026-11-13). Nothing built; step 0 has not run. The engine
beside whisper.cpp for desktop dictation. How voice works now:
`docs/context/voice.md`; earlier decisions: `docs/desktop_voice_plan.md`,
`docs/voice_gpu_plan.md`.

## Why

whisper.cpp is the only engine. `small` q5_1 (the default) is rough on German and
English; `large-v3-turbo` is good but takes 14 s for an 11 s clip on the CPU
(1.1 s on the Vulkan GPU). NVIDIA's `parakeet-tdt-0.6b-v3` (25 European
languages, punctuation and casing built in, CC-BY-4.0) reports 5.0 % German
WER on Fleurs, near large-v3 (4.3 %) and far better than `small` (10.2 %,
third-party blog, indicative). As an int8 ONNX pack it decodes at roughly 17-40x
real time on a modern x86 CPU (sources below; no Zen 5 figure exists), so a
10 s burst should cost about half a second on the CPU, with no GPU stack.

What it costs: no forced language (it detects per utterance; one public report
has 24 of 240 German clips come out in another language), no initial prompt or
hotwords in the released crate, 1.6-2.1 GB RSS, a 670 MB download.
Whisper therefore stays: forced language, `initial_prompt`, small models, GPU.

## Step 0: a gated bench on the host (no code lands before it)

Written 2026-11-13: `tmp/voice-bench/run-parakeet.sh` (sherpa-onnx
`linux-x64-shared-no-tts` archive and model files pinned by sha256, model repo
at `ed5d7456`; also runs the model repo's own `test_wavs/de.wav`/`en.wav`).
Not yet run.

A fenced tab has no network and no `/dev/dri`; the user runs it from a host
terminal or the Host session. An agent writes `tmp/voice-bench/run-parakeet.sh`
(gitignored, beside `run-on-host.sh`, which it copies in style): fetch the
sherpa-onnx v2.0.1 offline CLI (the `shared` release archive, which ships
`sherpa-onnx-offline`) and the `csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`
files at one commit; print their `sha256sum` (these become the catalog pins;
`tokens.txt` has no published hash); run every clip under
`/usr/bin/time -v`. Clips: `jfk.wav` (11 s English; it sits inside
`tmp/voice-bench/wc.tgz` under the whisper.cpp `samples/`, `tmp/voice-bench/samples/`
is empty) plus about 20 German clips the user records into
`tmp/voice-bench/samples/`: 10 of 1-4 s, 5 quiet, 5 of 10-25 s, 3 breath/room
noise with no speech, and a few English ones. Compare with `whisper-cli`
(already built by `run-on-host.sh`) on `small` and `large-v3-turbo`, forced
`de`/`en`, same clips.

| Measure | How |
|---|---|
| Speed | warm RTF, 5 runs median, 8 threads (the app's clamp) and 4 |
| Quality | WER by eye on the German and English clips, three engines side by side |
| Language flips | German clips that come out non-German, per 20 |
| Noise | text produced on the 3 no-speech clips (hallucination) |
| Memory | peak RSS, and RSS after the process drops the recognizer (long-lived in-app) |
| Load | cold and warm model load seconds |
| Length | the 25 s clip whole vs split at 15-20 s |

**Stop the plan (or switch to the nemotron option) if** any of: more than 1 in
20 German clips of 2 s or longer flips language on the user's own voice;
German WER by eye is not clearly better than `small` and at least comparable
to `large-v3-turbo`; warm RTF above 0.25 on this CPU (a 10 s clip taking over 2.5 s); peak RSS above 2.5 GB or cold load
above 10 s; or the no-speech clips produce text on more than 1 of 3. If only
the flip rate fails, step 0 is rerun with the nemotron unified pack once
sherpa-onnx ships it (PR #4141 and issue #4127 are open); until then that is
a "wait", not a "build".

## Fixed decisions

What the code and research settle (the user's earlier decisions carry over):

- **The seam exists.** `session::Transcriber` / `TranscriberFactory`
  (`session.rs:178-200`) are engine-neutral and stay unchanged. Everything
  whisper-typed is in `stt.rs` (the only `whisper_rs` user). Parakeet is a
  sibling `parakeet.rs` plus a thin dispatch; no trait changes.
- **CPU only in the first version.** ONNX Runtime has no usable AMD iGPU
  provider on Linux (ROCm EP removed in ORT 1.23); ggml/Vulkan gave about 2x
  on a 4750U and risks a duplicate-ggml clash with `whisper-rs-sys`. The device
  label still says what happened: `CPU`, reason "this model runs on the CPU only".
- **Whisper stays the default and `small` stays the default model.** Parakeet
  is a catalog entry the user picks; nothing migrates.
- **The feature sits outside `default`**, like `voice-vulkan`: a clean build, the
  gates and the sandbox must not download a native archive.
  Bundles and the dev build opt in. It is independent of the `voice` (whisper)
  feature, and out of `voice-io`, so the Windows/macOS cross-checks
  (`scripts/ci-local.sh:198`) are untouched and `desktop` never pulls it in.
- **All three platforms in one round** (Linux x64, Windows x64, macOS universal;
  `ci-cd.yml` packages no other target). Only Linux gets measured here.
- **The catalog id is the engine.** `ModelKind::Parakeet`; one `voice_model`
  setting and one picker list both engines, no `voice_engine` setting.
- **Model files are fetched per file from Hugging Face at a pinned commit** with
  our own SHA-256 and exact size, through the existing `fetch_posix` /
  `fetch_powershell` (hash before rename), in `<state_dir>/voice/models/`,
  never mounted into a fence, one click in an install tab.
- **`lang` and `prompt` are ignored by Parakeet** (it takes neither). The
  renderer never sends `prompt` today (`desktopVoice.ts` omits it), so ignoring
  it loses nothing yet; the voice-navigation hints (`voice_navigation_plan.md`)
  would be whisper-only.
- **`no_speech` is 0.0** for Parakeet; `phantom::keep` still runs (its tables
  and tag filter are harmless) and a Parakeet empty text is dropped as now.
- **Segments reach the engine up to 30 s** (`vad.rs` `max_segment_ms`), but the
  model wants 15-20 s: `parakeet.rs` splits at the quietest 100 ms frame inside
  a 12-20 s window and joins the pieces with a space. The session's VAD cap is
  not changed.
- **One engine in memory at a time.** Loading one drops the other's cache; each
  has its own cache and 5-minute reaper; `stop_for_exit` releases both.
- **Cancel is coarse.** A sherpa decode cannot be aborted; the `cancel` flag is
  checked between chunks. A final queued behind a partial waits at most one
  partial decode (a 5 s tail, a fraction of a second).
- **Safety.** No new command is expected (`voice_status` grows a field,
  `voice_model_install_script` takes the new id), so no `command_class` row;
  if one appears it is `Client`. No app name in code; every string via
  `i18n`; tests cross-OS (`Path::join`, no `"a/b"` literals).

## Open decisions for the user

Recommended option first.

**Decided by the user 2026-11-13:** 2 → (a) v3 int8 now; 3 → (a)
`voice-parakeet` opt-in, bundles + dev build on; 4 → (a) warn only; step 0 runs
on the host before any code lands. 1 and 5–10 are still open; the recommended
option holds unless the user says otherwise.

1. **Runtime crate.** (a) official `sherpa-onnx` 2.0.1, Apache-2.0, static ONNX
   Runtime, prebuilt `-lib` archives for all targets, pack made by the same
   project. (b) `parakeet-rs` 0.4.4 (single maintainer, `ort` rc.15, downloads
   ORT, hash-checked, no German-forcing either; supports nemotron `target_lang`
   today). (c) hand-written `ort` TDT decode. Not (c).
2. **Model: v3 or nemotron-labs-unified-asr-0.6b.** (a) v3 int8 now, the one
   with a released sherpa pack. (b) nemotron unified later: a real `target_lang`
   (fixes the flip), same 25 languages, OpenMDW 1.1 licence (needs your read),
   not in the released sherpa-onnx, no int8 recipe yet. Keep (b) as a second
   catalog row once sherpa merges #4141; do not make it the default.
3. **Cargo feature name and membership.** (a) `voice-parakeet`, outside
   `default` and `voice-io`; bundles + dev build opt in (as above). (b) in
   `default`: every clean build and gate then downloads the archive; no.
   Also decide whether the dev build (`scripts/package-dev.sh`) always opts in,
   and whether a bundle may ship without it when the fetch fails (recommended:
   no, the fetch is pinned and fails the job).
4. **Forced language (`voice_lang` is `de`, and by default the UI language).**
   (a) Warn only: the model row and picker say "detects the language itself";
   no automatic recovery in v1; step 0's flip rate decides if more is needed.
   (b) Post-check: a cheap script/stop-word check on the text and a retry of the
   same audio on whisper `small` with the forced language when it looks wrong
   (needs two engines loaded, about +0.5 GB, and a whisper `small` install).
   (c) Refuse Parakeet whenever the language is forced, so it is only usable on
   "detect". Pick (b) only if step 0's flip rate is above zero.
5. **Hotwords / name hints.** (a) None in v1; whisper keeps `initial_prompt`.
   (b) Wait for sherpa-onnx 2.0.2 (hotword fix PR #4084 landed one day after
   2.0.1) and then add `modified_beam_search` hotwords. (c) Build the crate
   from master via `SHERPA_ONNX_LIB_DIR` now; no.
6. **Voice-activity confirm (`confirm_speech`).** (a) Skip in v1: `vad.rs`
   already gates segments and step 0 measures the noise clips. (b) Add the
   ~2 MB sherpa `silero_vad.onnx` as a second `Vad`-kind catalog row (the
   `models.rs` test that counts one VAD row changes).
7. **Settings shape.** (a) Nothing new: `voice_model` carries `parakeet-v3`;
   the GPU switch and device row stay and the row reads `CPU` with the reason.
   (b) A per-engine thread-count or "keep loaded" setting. Not unless step 0
   shows the RSS needs a shorter keep-loaded time than 5 minutes.
8. **Catalog shape.** (a) Per-file entries (a multi-file `CatalogEntry`: four
   files, 665 MB total, installed = every file at its exact size). (b) The
   GitHub `…int8.tar.bz2` release asset (no published digest; bzip2 on
   Windows; we would hash it ourselves). Piper already unpacks archives
   (`piper.rs`), so (b) is possible; (a) is preferred because each file is
   hashed by Hugging Face's LFS oid and reuses the fetch helpers unchanged.
9. **Attribution (CC-BY-4.0: credit, licence link, "converted to int8 by
   sherpa-onnx", no endorsement).** (a) Say it where the model is chosen and
   installed: the install script banner (`echo` lines), a Settings → Voice help
   line, and `docs/third_party_update_checklist.md` §21. (b) Also a shipped
   notices file in the bundle: the repo has none today (only
   `.claude/skills/THIRD_PARTY_NOTICES.md`), so this starts one. Recommend (a)
   now and (b) if you want a notices file at all.
10. **A worker process for inference** (survives an ORT crash, returns RSS on
    unload; Handy does it). (a) No, in-process like whisper. (b) Yes, a child
    with a pipe. Pick (b) only if step 0's RSS-after-drop is bad.

## Steps

Each step names its files; paths are under `src-tauri/` unless noted.

### 1. Cargo feature and the native archive

- `Cargo.toml`: `voice-parakeet = ["voice-io", "dep:sherpa-onnx"]` with the
  rationale comment in the voice block; `sherpa-onnx = { version = "=2.0.1",
  optional = true, default-features = false, features = ["static"] }`. Cargo.lock
  moves. `deny.toml` already allows Apache-2.0 (its graph is `all-features`).
- sherpa's `build.rs` downloads the archive with no checksum. So CI, scripts
  and the dev build never let it: a new `scripts/lib/sherpa_native.sh`
  (`sherpa_native_prepare` for bash, a PowerShell twin for the Windows job)
  fetches the pinned `-lib` archive per target, checks a SHA-256 kept in one
  place, and exports `SHERPA_ONNX_ARCHIVE_DIR`. The exact archive name the crate
  asks for per target is read from the crate's `build.rs` first (unverified).
  Hashes are pinned in `ci-cd.yml` `env:` like `VULKAN_SDK_SHA256_*`; a
  mismatch fails the job. Offline sandboxes and the user's machine use the same
  script (cached under `<repo>/target/`, not the home).
- Wire it: `scripts/package-local.sh`, `scripts/package-dev.sh` (add the feature
  where the archive is available, a warning and no feature where it is not, like
  `voice_gpu_feature`), `ci-cd.yml` (`test-ubuntu` runs clippy and the voice
  tests with `--features voice-parakeet`; `package-windows`, `package-linux`,
  `package-macos` add it to their `--features`), `scripts/gates.sh` (two gates,
  run when the diff touches `services/voice/`, `Cargo.toml` or the script:
  `cargo clippy -p tabtivity --lib --features voice-parakeet -- -D warnings`
  and `cargo test -p tabtivity --lib --features voice-parakeet voice::`), and the
  gate list in `AGENTS.md`.
- **Prove the link on all three OS before anything else is built on it.** Open
  points: sherpa's Windows archive is built with the static CRT (`/MT`) while
  Tauri and `whisper-rs-sys` use the dynamic one (`LNK2038`); the macOS
  universal build needs both arch archives; a static ORT beside ggml in one
  binary is unproven; the Linux archive is built without the CXX11 ABI (the C
  API, which Rust uses, is reported unaffected). Fall-back if a platform fails:
  the crate's `shared` feature plus shipping the DLL/dylib/so beside the exe.
  This step ends with a CI run, so the user decides when the branch is pushed.

### 2. Catalog, install script, tests (`services/voice/models.rs`)

- `ModelKind::Parakeet`. `CatalogEntry` gets `files: &[CatalogFile]`
  (`name`, `sha256`, `size`) in place of `file`/`sha256`/`size`; whisper rows
  hold one file, so `model_path(entry)` stays the whisper path and a new
  `model_dir()`/`file_path` serves Parakeet. Pack id `parakeet-v3`:
  `encoder.int8.onnx` (652,282,294 B), `decoder.int8.onnx` (11,845,274 B),
  `joiner.int8.onnx` (6,355,277 B), `tokens.txt` (93,939 B); sizes and the three
  published LFS hashes from the research, the fourth hash and the repo commit
  from step 0, never `main`.
- `installed_in` = every file at its exact size. `states()` omits Parakeet rows
  in a build without `voice-parakeet`, so an unbuilt engine is never offered.
  `whisper_entry` becomes `listen_entry(id)` (kind is not `Vad`) at its callers
  (`mod.rs:262`, `:335`); `install_script` fetches the chosen model's files and,
  for a Whisper model, the ggml Silero file (a Parakeet install adds no VAD in v1,
  decision 6). The Parakeet script prints the attribution banner (decision 9).
- Tests (cross-OS, no `"a/b"` literals): every file of every entry pinned (hash,
  commit, size, no `/main/`), unique ids, the bash and PowerShell scripts check
  each file's hash before its rename, a half-installed pack is not installed
  (one file short by a byte), ids that are not listen models get no script, the
  VAD-count test follows decision 6.

### 3. The engine (`services/voice/parakeet.rs`, `engine.rs`, `gpu.rs`, `mod.rs`)

- `parakeet.rs`: `BUILT = cfg!(feature = "voice-parakeet")`, a `Factory { dir }`
  implementing `TranscriberFactory`, a no-feature stub answering
  `VoiceError::NotBuilt` (as `stt.rs` does). `load` builds an
  `OfflineRecognizer` (transducer config from the four files, int8, greedy,
  threads `clamp(1,8)`, provider `cpu`) on the worker thread. A global cache
  of one recognizer keyed by the model dir, the same 5-minute reaper as
  `stt.rs` and `release_now()`; loading drops the whisper cache and the other
  way round (a `release_other` hook in `engine.rs`). Check in the crate whether
  the recognizer is `Send`/`Sync` before sharing it through an `Arc`.
- `transcribe(audio, partial)`: peak-normalise audio quieter than a floor (sherpa's
  frontend is poor on very quiet input), skip clips under about 0.4 s (the
  shortest clip sherpa accepts is read off step 0), split at 15-20 s as above,
  decode each piece with a fresh stream, join with a space, check `cancel`
  between pieces, return `Transcript { text, no_speech: 0.0 }`. A partial
  decodes the last 5 s the session already hands over. `confirm_speech`: the
  default `true`. `device()`: `Cpu { reason: EngineCpuOnly }`, recorded with
  `gpu::record` so Settings and the live row show it.
- `gpu.rs`: `CpuReason::EngineCpuOnly` (kebab `engine-cpu-only`), `choose` unchanged.
- `engine.rs` (about 80 lines): `enum Factory { Whisper(stt::Factory), Parakeet(parakeet::Factory) }`
  implementing `TranscriberFactory` with `type T = enum Engine` that forwards
  `transcribe`/`confirm_speech`/`device` by `match`; `built(kind)`;
  `release_now()` calling both caches. `stt.rs` itself keeps only whisper.
- `mod.rs`: `ModelState` gains `unavailable: Option<VoiceError>` per model
  (whisper: `NotBuilt`, or `CpuUnsupported` when `cpu::supported()` fails;
  Parakeet: `NotBuilt`), `status().listen` is `None` when any engine can listen,
  and `cpu::supported()` gates only the ggml path (ONNX Runtime selects its
  kernels at run time; confirmed only by step 0's host and by a run on an
  AVX2-less CPU, which nobody here has: say so in `cpu.rs`' doc). `listen_start`
  builds `engine::Factory` from the catalog kind. `stop_for_exit` calls the
  engine's `release_now`. `valid_lang` stays; Parakeet ignores the value.
- Tests: `FakeTranscriber`-based session tests need no change; add chunking
  (split point inside the quiet window, never past 20 s, pieces joined), the
  normalise and short-clip rules, `Cpu { EngineCpuOnly }` is what `device()`
  reports, `status()` omits unbuilt engines, and an `#[ignore]` real-model test
  (below).

### 4. Frontend (`src/lib/voice/desktopVoice.ts`, `ReaderVoice.tsx`, `VoiceSettings.tsx`)

- `desktopVoice.ts`: `VoiceModelState.kind: "whisper" | "parakeet" | "vad"` and
  `unavailable`; `VOICE_MODELS` gains `"parakeet-v3"`; `VOICE_MODEL_LABELS` and a
  `VoiceCpuReason` member `"engine-cpu-only"` with its `VOICE_CPU_REASON_KEYS`
  row (a missing row fails `tsc`); a `voiceModelOptions(status)` helper that
  lists only models the status offers, so an unbuilt engine never shows and a
  stored `voice_model` the build lacks falls back to the default instead of an
  install card for something that cannot install.
- `ReaderVoice.tsx`: the `m.kind === "whisper"` filter (line 183) becomes
  `kind !== "vad"`; the picker (`:429`, `:462`) and the install card use
  `voiceModelOptions`; the label row prints `CPU` with its reason tooltip.
- `VoiceSettings.tsx`: the options list, a one-line note under the model row when
  Parakeet is selected ("picks the language itself; the language setting and
  name hints do not apply"), the attribution line (decision 9), and the GPU
  switch dimmed with its reason while Parakeet is chosen.
- Tests: `src/__tests__/terminal/ReaderVoice.test.tsx` and a `VoiceSettings`
  test for the options, the fallback, the note and the device label.

### 5. Shared files, applied once by the main agent

- i18n in `en.ts`, `de.ts`, `es.ts`, `fr.ts`, `it.ts` (English holds every key):
  `settings.voice.modelParakeet`, `settings.voice.parakeetNote`,
  `settings.voice.parakeetCredit`, `terminal.reader.voice.cpu.engineCpuOnly`,
  and the reworded `settings.voice.modelHelp` / `langHelp` where they say
  "whisper". No hard-coded text, no app name.
- `src/lib/untested.ts`: rows `settings.voice.parakeet` and
  `terminal.reader.voice.parakeet` with `UntestedTag` pills on the model row and
  the live row.
- `command_class.rs` + `commandClasses.ts`: only if a command was added (none
  planned).
- `docs/filemap_backend.md` (the `voice/` row: `parakeet.rs`, `engine.rs`),
  `docs/filemap_frontend.md` (the `VoiceSettings.tsx` and `ReaderVoice.tsx`
  rows), `docs/context/voice.md` (a section "A second engine"),
  `docs/third_party_update_checklist.md` §21 (sherpa-onnx pin, the pack and
  its hashes, what to re-check on bump), `AGENTS.md` (the new gate lines), and
  this file's status line.

## Verification

- Gates per `AGENTS.md` (`scripts/gates.sh` in the background, then
  `scripts/gates-job.sh status`), plus the two new `voice-parakeet` gates and
  `scripts/brand-check.sh`, `scripts/privacy-check.sh` (a four-part dotted version
  reads as an IP address; keep sherpa's three-part one). Local gates
  build only Linux; CI proves Windows and macOS. `npm run backend:stale` after
  the Rust edits; never restart the app.
- The real-model analogue of `a_real_load_says_where_it_landed`, by hand on the
  host: `VOICE_TEST_MODEL_DIR=<dir> cargo test -p tabtivity --lib --features
  voice,voice-parakeet -- --ignored --nocapture a_real_parakeet_decodes`. It loads
  the pack, decodes a bundled 16 kHz clip and a 25 s concatenation, asserts text,
  the `EngineCpuOnly` device and that the cache drops on `release_now`. With `voice`
  and `voice-parakeet` both on it also proves both engines link into one test binary.
- Click-through for the user, in the frozen dev build (never run live by an agent;
  the dev build picks the feature up once committed):
  1. Settings → Voice → model: **Parakeet** shows its size, the credit and the
     "picks the language itself" note; Install opens a tab, prints the banner, the
     four files pass their hashes, and the row says installed.
  2. Mic on in a Chat with Parakeet: the row under the composer says `CPU`, the
     tooltip says this model runs on the CPU only; the first dictation takes a few
     seconds to load, the second does not.
  3. Dictate a German and an English sentence, a 25 s monologue, and silence:
     punctuated text, no cut mid-word at the 15-20 s mark, nothing for silence.
  4. Switch to `small` and back while listening: one engine loaded at a time
     (watch RSS), no stale text.
  5. Hands-free: send guard and stop word behave as with whisper.
  6. With the language forced to German, say a short quiet sentence five times:
     note how often it comes out in another language (decision 4).
  7. On Windows and macOS, once a machine exists: the app starts, the model
     installs and decodes.

## Agent steps

One subsystem each, at most about 1.5 days and 3 large files. Contract agreed up
front so the waves can overlap: `ModelState { id, kind, installed, sizeBytes,
unavailable }`, kind `"parakeet"`, `CpuReason::EngineCpuOnly` / `"engine-cpu-only"`,
model id `parakeet-v3`.

| Agent step | Plan sections | Files |
|---|---|---|
| A. Build and CI | Step 1 | `Cargo.toml`, `Cargo.lock`, `scripts/lib/sherpa_native.sh` (+ `.ps1`), `ci-cd.yml`, `package-*.sh`, `gates.sh` |
| B. Catalog and install | Step 2 | `services/voice/models.rs` (+ its tests; the `piper.rs` helpers are only called, not edited) |
| C. Engine | Step 3 | `services/voice/parakeet.rs` (new), `engine.rs` (new), `mod.rs`, `gpu.rs`, `cpu.rs` doc, `stt.rs` (release hook only) |
| D. Frontend | Step 4 | `lib/voice/desktopVoice.ts`, `ReaderVoice.tsx`, `VoiceSettings.tsx`, the two tests |
| E. Review | Verification | the finished diff, read against this plan (fresh context, read-only) |
| Main agent | Step 0 script, Step 5 | the shared files; runs gates; reports |

## Organisation

Shape: step 0 first and alone (it can stop everything); then two waves and a
review. Wave 1: A and B in parallel (disjoint files). Wave 2: C (needs A's
compiling crate and B's entry type) and D (needs only the contract) in parallel.
Then E. Dependency graph: step 0 -> {A, B} -> {C, D} -> E; the main agent
applies step 5 once after C and D, so the hot shared files (the five i18n
dictionaries, both filemaps, `command_class.rs` + `commandClasses.ts`,
`untested.ts`, `AGENTS.md`) get one writer. Another session currently has
uncommitted edits in `src-tauri/src/lib.rs`, `services/command_class.rs`,
`services/mod.rs` and in the i18n dictionaries, `commandClasses.ts`,
`untested.ts` and both filemaps: nothing here edits `lib.rs` or `services/mod.rs`,
and step 5 waits until that work is committed (or edits only appended lines and
re-reads before writing). Five agents, at most two at once, a few larger ones
rather than many small: the engine is the one hard part and should have one head.

## Risks

- **Link failures** on Windows (static CRT), macOS universal and Linux (static ORT
  beside ggml, CXX11 ABI): step 1 is a gate; the fallback is `shared` linkage.
- **Language flips on short German speech**, the main functional loss; step 0
  measures it, decision 4 handles it, nemotron unified is the real fix.
- **Memory**: 1.6-2.1 GB resident, and ORT arenas rarely return it to the OS;
  one engine at a time and the reaper limit it, decision 10 is the escape.
- **In-process crash** (sherpa-onnx issue #3983, a heap overflow on a vocabulary
  mismatch) would take the window and its tabs down; the pack is pinned and
  hashed so the mismatch cannot arise from a bad download.
- **Build supply chain**: sherpa's `build.rs` downloads unchecked; only our
  pinned fetch may feed it, and the local gates must fail loudly rather than
  fall back to the network.
- **Unproven on any CPU without AVX2** and on any German dictation outside step 0.
- **Licences**: CC-BY-4.0 attribution must ship with the model; nemotron's
  OpenMDW 1.1 is read before it is offered.

## Sources

- Model card, languages, WER: https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3
- sherpa-onnx int8 pack and file sizes (HF tree API):
  https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8
- Crate and its `build.rs` (no checksum; `SHERPA_ONNX_ARCHIVE_DIR` /
  `SHERPA_ONNX_LIB_DIR`): https://docs.rs/crate/sherpa-onnx/2.0.1/features ;
  https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/master/sherpa-onnx/rust/sherpa-onnx-sys/build.rs
- Release v2.0.1 archives: https://api.github.com/repos/k2-fsa/sherpa-onnx/releases/tags/v2.0.1
- Hotword fix (after 2.0.1): https://github.com/k2-fsa/sherpa-onnx/pull/4084
- Nemotron unified in sherpa (open): https://github.com/k2-fsa/sherpa-onnx/issues/4127 ;
  card: https://huggingface.co/nvidia/nemotron-labs-unified-asr-0.6b
- Language-ID flips on German clips: https://github.com/Mupu/SleepTalkRecorder/issues/69
- Real-time factors and RSS: https://github.com/oldcai/LazyTyper-releases/releases/tag/parakeet-tdt-0.6b-v3-q8w-v1 ;
  https://huggingface.co/lwittich/parakeet-tdt-0.6b-v3-onnx-int8-cpu
- Whisper comparison (indicative): https://whispernotes.app/blog/parakeet-v3-default-mac-model
- Why not ggml/Vulkan or `parakeet-rs`: https://raw.githubusercontent.com/handy-computer/transcribe.cpp/main/catalog/parakeet-tdt-0.6b-v3.json ;
  https://github.com/altunenes/parakeet-rs ; https://github.com/cjpais/Handy/issues/2074
- CC-BY-4.0 obligations: https://creativecommons.org/licenses/by/4.0/

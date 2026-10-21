# Desktop voice: dictation, read-aloud and hands-free in the Chat

Status: plan only (2026-10-21). Nothing implemented.

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
   enough.** Phase 1 uses the `tts` crate: speech-dispatcher on Linux (already
   installed on the host), SAPI/WinRT on Windows, AVSpeechSynthesizer on
   macOS. The user tests it live. Only if they find it not good enough does
   phase 2 add Piper neural voices (step 7). Phase 1 still builds the
   `TtsEngine` seam and the voice-engine setting, so adding Piper only adds
   code and changes nothing that was built in phase 1.
3. **Phone parity plus hands-free in phase 1.** Parity: a mic toggle in the
   composer, a live "Heard:" line, the words going into the draft, the spoken
   send, and a read-aloud toggle. Hands-free: voice-activity detection sends
   after a pause, the mic opens again once the answer has been read, and a key
   interrupts it (also your voice, with a headset).
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
- **Hands-free stays bound to its tab.** If the tab is hidden, the mic pauses
  and nothing is read aloud. When the tab is shown again, the answer that came
  meanwhile is read and the mic reopens (`PaneVisibleContext`).
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
            (phase 2 adds PiperTts behind the same seam)
```

The backend owns the audio; the renderer owns the words. The backend never
sends a prompt itself. Every send goes through `ReaderComposer.send()`, so slash
commands, subagent routing, the AI switch ⏻ and the `onSentPrompt` "sending"
state all behave exactly as for a typed prompt.

## Phase 1: OS voice

### 0. Probes (before any code lands)

- `whisper-rs` (pin the newest version that is at least two weeks old) builds
  with cmake in all three CI jobs **and** in `scripts/ci-local.sh`'s
  cross-checks. The Windows clippy/check runs build scripts through the msvc
  shims, and the `aarch64-apple-darwin` check runs them too. If the
  cross-checks cannot compile whisper.cpp, decide with the user before step 2:
  gate it out of the cross-check target via a `voice` feature, or ship
  whisper.cpp's server as a wrapped tool instead.
- Check whether the pinned `whisper-rs` exposes whisper.cpp's Silero VAD (a
  ggml model of about 1 MB). If not, fall back to the `webrtc-vad` crate.
- `cpal` capture on PipeWire (the host), and the `tts` crate's
  speech-dispatcher backend, including whether it reports the end of an
  utterance (the hands-free loop needs it). Test each in a scratch binary
  outside the repo.
- Record the results in this file.

### 1. Shared voice text helpers — `shared/voice.ts`

Move these pure helpers out of `mobile-web/src/` into `shared/voice.ts`, next
to `shared/agentComposer.ts`:

- `spokenSend` and `sanitizeVoiceTranscript`;
- the `DictationProgress` trio: `settleDictation`, `dictationPreview` and the
  insert step;
- `spokenText` and `speechChunks`.

`mobile-web` re-imports them from there, so the phone's behaviour does not
change. Their existing tests (`src/__tests__/mobile/MobileVoiceInput.test.ts`
etc.) move with them. Add two new helpers:

- a stop-word helper next to `spokenSend`: "stop" (German "stopp") said
  alone, used only in headset mode;
- an option matcher for question cards ("one", "option two", "zwei" …).

### 2. Backend voice service — `src-tauri/src/services/voice/`

Behind a `voice` cargo feature that `desktop` turns on. The daemon build
(`--no-default-features`) never links `cpal`, `whisper-rs` or `tts`, and its
`ldd` stays clean. The service modules stay `AppHandle`-free.

- `voice/models.rs` — the catalog:
  - Each entry has an `id`, a file name, its URL in the whisper.cpp
    Hugging Face repo, a pinned SHA-256, the size and a label key. Models live
    in `<state_dir>/voice/models/`.
  - `install_script(id)` writes a fetch-and-verify script, copying the pair
    `vm.rs` uses for `fetch-base.sh` / `.ps1`: `curl` to `.part`, verify the
    hash, `mv`. It runs in a tab, following the one-click install rule.
  - Only a catalog id is ever accepted; the renderer never passes a path or a
    URL.
- `voice/capture.rs` — the microphone:
  - The `cpal` default input device, resampled to 16 kHz mono, feeding a ring
    buffer.
  - An RMS level on the same scale as the phone's meter, and a `muted` gate
    that the TTS side sets.
  - "No input device" and "permission denied" each get their own error key.
- `voice/vad.rs` — splits speech into segments:
  - Start threshold; end-of-speech silence of 700 ms for dictation; for
    hands-free, "send after pause" at 1.5 s, adjustable from 0.8 to 4 s.
  - A maximum segment length of 30 s, whisper's window.
  - Unit-tested on synthetic tone/silence buffers.
- `voice/stt.rs` — one worker thread holding the `WhisperContext`:
  - Loaded lazily, dropped 5 minutes after the last listen.
  - Each finished segment comes back as `final` text.
  - While a segment is still open, it re-runs about once a second on the
    growing buffer and returns `partial` text for the "Heard:" line. A
    partial is skipped while the last one is still running, which caps the
    cost.
  - It takes an optional initial prompt, for step 9's name hints.
  - Language: the desktop speech language (see step 3), or whisper's
    auto-detect.
- `voice/tts.rs` — `trait TtsEngine { speak(chunk, lang), stop(), voices() }`:
  - Phase 1's only implementation is `OsTts` over the `tts` crate.
  - A queue of chunks; `stop()` empties it.
  - A `speaking` flag drives the capture's mute gate and its 300 ms tail.
- `voice/mod.rs` — one `VoiceSession { owner, mode: Dictate | HandsFree,
  lang, headset }`. Only one at a time: a new start stops the old one.
  `owner` is an enum: `Tab(key)` now, `Window` for step 9's navigation, so
  that layer needs no second session type.
- `commands/voice.rs`:
  - Each command is `#[cfg_attr(feature = "desktop", tauri::command)]` and
    takes `tauri_host::Ctx`: `voice_status` (models installed, devices,
    engine), `voice_model_install_script`, `voice_listen_start`,
    `voice_listen_stop`, `voice_speak`, `voice_speak_stop`, `voice_voices`.
  - Events: `voice://level`, `voice://partial`, `voice://final`,
    `voice://speaking`, `voice://error`, `voice://owner`.
  - Each command gets a `Client` row in `command_class`; regenerate
    `src/lib/transport/commandClasses.ts`.
  - Register the teardown in `RunEvent::Exit`.
- macOS: add `NSMicrophoneUsageDescription` to the bundle's Info.plist, and
  `com.apple.security.device.audio-input` if the build is hardened.
- `docs/third_party_update_checklist.md`: rows for whisper.cpp / `whisper-rs`
  and the model catalog hashes.

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
- Rebindable shortcuts in `src/lib/shortcuts/steeringBindings.ts`: toggle mic
  and stop speaking. Pick defaults that do not collide with the
  `terminal.reader` or steering keys, and check the shortcut tables.
- i18n: `terminal.reader.voice.*` keys in English plus de/es/fr/it. Reuse the
  phone's wording where the text is identical.
- `UntestedTag` + `src/lib/untested.ts` rows: `terminal.reader.voice.dictate`,
  `.spokenSend`, `.install`, `.indicator`.

### 4. Read-aloud and the hands-free loop

- **Read-aloud.** A toggle in the Chat's menu, as the phone's
  `focusReadAloud`.
  - When the Reader's transcript shows the turn ended (`useActivityStore`
    busy → idle, plus the new answer turn), it speaks `spokenText` of the new
    answer in `speechChunks` through `voice_speak`.
  - It follows the phone's rule that only a short new tail is news
    (`Terminal.tsx`, around line 2367), and never reads while the user is
    dictating.
  - The shortcut, the indicator or any send stops it.
- **Hands-free** (`useExperimental`): mode `HandsFree` on the same session.
  - The end-of-speech pause sends the draft; the spoken send still works too.
  - Once the answer has been read, or right away if read-aloud is off, the mic
    opens again.
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
  pause (same setting range as the desktop). "go on"/"los" still works.
- After the send, the session stops with `stop()`, not `abort()`, so the last
  words are kept.
- When the agent's turn ends, the new answer is read through `speechOutput` as
  today. When the last chunk's utterance ends, the mic opens again (a new
  `startDictation`). With read-aloud off, it reopens as soon as the turn ends.
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
- File map rows: `services/voice/*`, `commands/voice.rs`,
  `src/lib/voice/desktopVoice.ts`, `shared/voice.ts`.
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
    through `voice://error`, never on every chunk.
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

It gets its own `docs/voice_navigation_plan.md`, with the user's decisions,
once phase 1 has been tested live. The shape it starts from:

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
  - VAD segmenter on synthetic buffers.
  - The model catalog: ids are unique, hashes are 64 hex characters, and the
    install script verifies before `mv`, per OS (`cfg!(windows)` literals).
  - The session's single-owner rule; the mute gate and its tail.
  - The shared helpers' tests pass unchanged after the move; the stop-word
    and option matchers.
  - `ReaderComposer` with a mocked `voice://` stream: final → draft; "go on" →
    `send` once without the words; hands-free pause → send; read-aloud only
    at the end of a turn and never while listening.
  - The phone loop with mocked recognition and synthesis: send → mic closed →
    answer spoken → mic reopened.
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
  5. Hands-free (Experimental): ask, pause, the answer is read, the mic
     reopens. The key interrupts the voice and the agent keeps going. With a
     headset and headset mode on, talking over the voice stops it.
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
- Batch A, in parallel: step 1 (frontend, small) ∥ step 2 (backend, one
  implementer: build-heavy, alone on cargo).
- Batch B, in parallel: step 3 (needs step 2's command and event names) ∥
  step 5 (phone, needs only step 1).
- Batch C: step 4. Batch D: step 6. Then stop for the test gate.
- Step 7 is its own run after the gate, only if needed. Steps 8–10 are later,
  separate plan runs.
- One reviewer per batch, checking against the fixed decisions above, and a
  final review across the whole diff. At most 2 cargo-running agents at once
  (the `/tmp` tmpfs).

## Risks

- whisper.cpp's C++ build in the cross-checks and on all three CI runners
  (step 0), plus added build time for the desktop binary.
- CPU load: `small` takes several cores for about a second per sentence, and
  partials cost more. Partials are skipped while one is still running, and a
  setting turns them off.
- speech-dispatcher's default espeak voice may sound too robotic. That is
  what the test gate is for; Piper is the answer if so.
- With the OS voice, hands-free without a headset depends entirely on the
  mute gate. The 300 ms tail covers audio still buffered in the output device
  after the `speaking` flag drops; the live test must confirm it.
- If the `tts` crate's speech-dispatcher backend does not report the end of
  an utterance (step 0), the loop needs another signal: estimate from text
  length, or poll speech-dispatcher's state.
- Phone hands-free needs the screen on and the page open, which is a hard
  limit of a web app on Android.
- Phase 2 only: Piper's packaging is in flux (MIT binaries frozen, GPL line
  Python-first), and echo cancellation through laptop speakers can let a loud
  voice leak through as a false barge-in.

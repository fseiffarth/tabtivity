# Mobile dictation on the desktop's ears — Whisper behind the phone's microphone

Status: plan, 2026-09-20. Nothing here is built. The groundwork that *is*
built (the recognizer kept alive through pauses, wake lock, level meter) lives
in `mobile-web/src/voiceSession.ts`.

---

## 1. Context

Tabtivity Mobile dictates through the browser's Web Speech API
(`mobile-web/src/voiceInput.ts`, `voiceSession.ts`). That API is the ceiling on
quality: Android's recognizer is a streaming command model — little or no
punctuation, weak on technical vocabulary ("clippy", "rebase", file names),
and it re-finalizes utterances, which is why `readDictation` /
`advanceDictation` carry ~100 lines of dedup heuristics.

Apps that feel good at this (ChatGPT's among them) do not use it. They record
audio and run a Whisper-class model over it. Tabtivity can do the same without a
cloud: the phone already talks to an authenticated desktop over the tailnet,
and the desktop has the CPU/GPU.

> The phone captures audio; the desktop transcribes it; text comes back into
> the composer's draft, never submitted on its own. Web Speech stays as the
> fallback whenever the desktop cannot transcribe.

Non-goals: cloud ASR (the microphone does not leave the user's machines);
voice *commands*; desktop-side dictation; always-on listening.

## 2. Shape

```
phone  AudioWorklet 16 kHz mono PCM ──► VAD cuts utterances
       POST /api/v1/speech  (raw body = one utterance, s16le)
desktop services::speech ──► whisper-cli (whisper.cpp) ──► { text }
phone  appends text to the draft
```

### 2.1 Phone — `mobile-web/src/voiceCapture.ts` (new)

- `getUserMedia` + an `AudioWorklet` that downsamples to **16 kHz mono s16le
  PCM**. Not `MediaRecorder`/Opus: PCM needs no decoder on the desktop (there
  is no ffmpeg here and Tabtivity should not grow one). 32 KB/s — a 30 s
  utterance is under 1 MB, nothing on a tailnet.
- Energy **VAD** in the worklet (the RMS `voiceSession.ts` already computes
  for the meter): an utterance ends after ~900 ms below threshold, or at a
  30 s cap (Whisper's window). Each utterance is posted as it ends, so text
  lands every sentence instead of once at the stop. Keep ~300 ms of pre-roll
  so first syllables survive.
- Same `DictationSession` surface as `startDictation` (`stop`/`abort`,
  `onStart`/`onLevel`/`onError`/`onEnd`) plus `onText(text)`. `Terminal.tsx`
  picks the engine; its handlers do not fork. `readDictation` is not involved:
  utterances arrive whole, once.
- Utterances are posted in order, one in flight; a failed post surfaces
  `mobile.voice.errDesktop` and keeps the session alive for the next one.
- Wake lock and the level ring are reused as they are.

### 2.2 Transport — `POST /api/v1/speech`

Modelled on `inbox_upload` (`mobile_control/host.rs`): `authenticate` +
`exact_origin`, raw body, its own `DefaultBodyLimit` (`MAX_SPEECH_BODY` =
30 s × 32 KB/s ≈ 1 MB, rounded to 2 MB). Query: `lang` (BCP-47 from
`speechTag()`, or absent for auto-detect). Answers `{ "text": "…" }`.

- Not tab-scoped: audio names no project, and nothing is written into one.
  The body lives in memory / a `tempfile` under the state dir's runtime
  folder and is deleted when the transcription returns. **Audio is never
  persisted and never logged.**
- `GET /api/v1/speech` → `{ available, model }` so the phone chooses its
  engine before the tap, without a failed upload.
- One transcription at a time (a `Semaphore(1)`); a second concurrent post
  waits, a third gets `429`. Timeout 60 s → `504`.
- Codes: `speech_unavailable` (503, no model/binary), `too_large` (413),
  `busy` (429), `failed` (500).

### 2.3 Desktop — `services::speech` (new, `AppHandle`-free)

- `transcribe(pcm: &[i16], lang: Option<&str>) -> Result<String, SpeechError>`
  writes a WAV header + samples to a temp file and runs
  `whisper-cli -m <model> -f <wav> -l <lang|auto> -nt -np` with a cleared
  environment, reading stdout. Output is sanitized exactly as
  `sanitizeVoiceTranscript` does (no control bytes) on **both** sides.
- Binary and model are located, never guessed: `which whisper-cli`, model
  under `<state_dir>/speech/ggml-<size>.bin`. Missing either ⇒ unavailable.
- Whisper hallucinates on silence ("Thank you.", "Subtitles by…"). The VAD
  keeps silence from being sent; the service additionally drops a result
  whose `no_speech_prob`/segment count says it heard nothing, and a small
  known-phantom list per language.
- The child joins `RunEvent::Exit` teardown (nothing outlives a clean quit).
- Later, if latency matters: keep a `whisper-server` child warm instead of a
  process per utterance. Not in the first cut.

### 2.4 Install & settings

- MobileSettings gets **"Transcribe dictation on this computer"** (off by
  default, `UntestedTag`, register row). Turning it on with nothing installed
  offers the one-click open-a-tab-and-run install: build/fetch whisper.cpp and
  download the chosen model (`base` 142 MB / `small` 466 MB / `medium` 1.5 GB;
  default `small`). Follow `docs/third_party_update_checklist.md`; the model
  URL and sha256 are pinned.
- Setting persisted with the other mobile toggles; default-absent = off, so
  existing state round-trips.
- Phone: no new setting. If `GET /speech` says available it is used, and the
  status line says so ("Listening — transcribed on your desktop…");
  otherwise Web Speech, as today.

## 3. Invariants this must keep

- `mobile_control`: no raw ids, paths or commands cross the API — the
  endpoint takes bytes and a language tag, returns text. The language tag is
  validated against `[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*` before it reaches argv.
- Nothing is filed into a project; nothing persisted.
- Dictated text is staged in the draft, never submitted.
- HPC/careful hosts are irrelevant: transcription is local to the desktop.
- Windows: `whisper-cli.exe` path lookup only; the install flow is
  Linux-first, Windows shows "install manually" until verified.

## 4. Steps

1. `services::speech` + unit tests (WAV framing, argv, lang validation,
   phantom filter, unavailable paths) — a fake `whisper-cli` script in tests.
2. `GET`/`POST /api/v1/speech` + host tests (auth, origin, limit, busy).
3. `voiceCapture.ts` worklet + VAD + session; vitest with a fake
   `AudioWorkletNode` feeding canned PCM.
4. Engine choice in `Terminal.tsx`; status strings via `i18n.ts`.
5. MobileSettings toggle + install flow + register row.
6. `npm run mobile:bundle`, `backend:stale`, filemap rows, a
   `docs/context/mobile_speech.md` rationale once it is real.

## 5. Open questions

- CPU-only latency of `small` on the user's desktop (no ffmpeg/whisper here to
  measure yet). If > ~2× realtime, default to `base` and offer `small`.
- Whether Chrome on Android lets a worklet capture run while the screen dims
  under the wake lock on low battery — live test only.
- Vocabulary priming: whisper's `--prompt` with the project's name and recent
  file names would fix most technical-word misses, but project data would then
  flow into argv for a phone request; decide after the plain version is judged.

## 6. Verification (live, by the user)

1. Toggle on, install, phone: tap Dictate → status says desktop transcription.
2. Speak two sentences with a pause: each lands in the draft punctuated,
   within a few seconds of its end; nothing is sent.
3. Stay silent 20 s: no phantom text.
4. Stop Tabtivity's speech setting / rename the model: phone falls back to Web
   Speech with no error.
5. Pull the tailnet mid-utterance: error line, session survives, next
   utterance works after reconnect.

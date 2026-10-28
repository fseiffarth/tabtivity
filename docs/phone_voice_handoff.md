# Phone hands-free voice — handoff

Plan: `docs/phone_voice_plan.md`. Each implementer appends its own section
below: what landed, interfaces it exposed, hot-file additions, gotchas, gate
status with test counts, and "Flagged for user".

## S0: probe page (branch `voice-s0`, `.claude/worktrees/voice-s0`)

Commit `4875b6eb` on `voice-s0` (from develop 70344a96), not pushed, never run
on a phone.

What landed:
- `mobile-web/src/voiceProbe.tsx` (new, its own lazy chunk): one page, one
  card per probe item, one probe running at a time. Each card has a Start
  button (the gesture), and a running probe can add its own buttons (Turn,
  Speak 5 s, Open mic 6 s). The sticky bar has **Mark ◆**, which puts a ◆ in
  the running probe's log (for "I heard a beep", "the music muted"), plus
  **Stop** and **Copy results**. Every recognizer event (`start`,
  `audiostart`, `soundstart`, `speechstart`, `speechend`, `final` with the
  alternatives, `error`, `end`), every TTS start and end, and every media
  button gets a log line with its time since Start. Each probe also keeps
  summary notes: gap stats (n/min/median/max), counts and verdicts.
  - 1a: speaks, then restarts a single-shot recognizer by code after each
    reply, no tap, for 1/2/5/10 min. Measures the gaps from TTS end to
    `start` and to `audiostart`, and from `end` to `start` when nothing was
    heard. Stops with a verdict on `not-allowed`, or when the recognizer
    keeps ending at once.
  - 1b: one continuous recognizer runs while the phone speaks a sentence
    every 15 s. Counts its ends (and how many fell while speaking), the
    restart gaps, the unbroken session lengths, and the finals or interims
    that arrived during speech (logged as DROPPED).
  - 2: the phone says a known sentence three times while listening.
    Reports the share of its words that came back, once with the plain
    recognizer and once with `start(track)` on the echo-cancelled track
    from `openMicMeter` (it logs the track's actual `echoCancellation`, and
    the mic peak level while speaking and while quiet).
  - 3: a silent looping `<audio>` with four sources: `webaudio`
    (MediaStreamDestination as `srcObject`, with an optional faint 40 Hz
    tone), `file` (`/silence.wav`; logs the served status and
    content-type), and `data` / `blob`, which are expected to be blocked.
    It sets Media Session metadata and handlers for play, pause, stop,
    next/previous track, seek backward/forward, seekto, togglemicrophone
    and hangup, and logs which handlers were refused. Every press is
    logged with the state at that moment (playing, speaking, mic open).
  - 4: lists the `getUserMedia` default input and every input and output
    label, and re-lists them on `devicechange`. Each **Turn** times the
    prompt, TTS end → `audiostart`, `speechend` → final, and the whole turn.
  - 5: continuous listening for a set time with nobody talking. Every final
    that matches a candidate word is logged as a FALSE TRIGGER.
  - 6: no wake lock. Mode `mic` (getUserMedia plus level samples) or mode
    `recognizer`. Logs visibility, `freeze`/`resume`/`pagehide`/`pageshow`
    and track `ended`/`mute`/`unmute`. When the page comes back it reports
    what survived, and then tries a restart without a tap.
  - 7: the candidates are `BRAND.display` (never spelled) plus a
    comma-separated field. You pick the word, 1 m / 3 m and fan off/on, and
    each final is sorted as one of: `token` (the candidate's words
    appear exactly), `split` (2–3 adjacent words that join into it, e.g.
    "tab tivity"), `alt` (only in a lower-ranked alternative,
    `maxAlternatives` 3) or `miss`. Every utterance plays the chime. The
    cells add up across runs, and the card shows them as a table.
  - Setup card: language (default `speechTag()`), an on-device switch, and
    **Check on-device** (`prepareOnDeviceSpeech`; it turns the switch on
    when the result is `local` or `installed`).
- `mobile-web/src/main.tsx`: renders `<VoiceProbe/>` (behind `React.lazy` +
  `Suspense`) instead of `<App/>` only when the URL has `?voiceProbe`
  and `localStorage[storageDashKey("show-untested-tags")] === "true"`. That
  is the key App.tsx writes from `getMobileStatus().show_untested_tags`.
  Otherwise the app renders as before, and the probe chunk is never fetched.
- `mobile-web/public/silence.wav` (new, 48 044 B): 8-bit mono 8 kHz PCM,
  6 s at the zero line. Its blob id `963fe49c…` is in
  `scripts/privacy-reviewed-binaries.txt` (hot file, S0 only).
- `mobile-web/src/voiceSession.ts`: `holdScreenAwake`, `openMicMeter` and
  `MicMeter` are now exported, so the probe reuses them. Nothing else
  changed there. S3 may keep these exports or fold them back.
- Reused: `speak`/`subscribeSpeech`/`currentSpeechId`/`stopSpeaking`/
  `unlockSpeech` (speechOutput), `speechRecognitionConstructor`/
  `prepareOnDeviceSpeech` (voiceInput), `speechTag` (speechLang),
  `playChime`.
- No i18n keys, no untested row, no CSS (inline styles in fixed dark
  colours), as the plan records for this dev tool. S11 deletes
  `voiceProbe.tsx`, the gate in `main.tsx` and `silence.wav` together
  with its reviewed-binaries line.

How the user opens it on the phone:
1. Relaunch the frozen dev build that contains this commit (the phone
   bundle is baked into the binary; this commit queues the build).
2. On the desktop: Settings → General → **Show untested tags** on.
3. On the phone, open the Tabtivity app once, signed in, and leave it in
   front for a few seconds. The status probe caches the flag right away
   and again every 30 s.
4. In **Chrome** on the phone (the installed app has no address bar), open
   the same address the phone app uses, with `/?voiceProbe` added, e.g.
   `https://<your phone address>/?voiceProbe`. Chrome shares the installed
   app's storage. If the plain app opens instead, the flag is not cached in
   that browser: sign in there once (step 3), then reload.
5. Run the probes. In the kitchen: Setup → Check on-device, then 1a, 1b, 2,
   3 (webaudio, then file), 5 with the fan on, 6 (both modes), and 7 (the
   app's name at 1 m and 3 m, fan off and on, 10 times each). In the car,
   on Bluetooth: 3 (webaudio and file, the steering-wheel buttons before
   and after Open mic) and 4 (several Turns). Then **Copy results** and
   paste the text back.

What Copy results gives (shape; the real lines vary):
```
VOICE PROBE 0.2.47 · ab12cd 2026-10-29T08:12:03.000Z
ua: Mozilla/5.0 (Linux; Android 15; …) Chrome/141…
lang=de-DE on-device=on (check: local (40 ms)) · browser tab · secure=true
SpeechRecognition=yes speechSynthesis=yes (31 voices) mediaSession=yes wakeLock=yes AudioContext=yes

[p1a] 1a · Restart after speaking, no tap · runs 1
  cycles: 37
  tts end → rec start: n=18 min=180 med=260 max=900 ms
  tts end → audiostart: n=18 min=420 med=510 max=1300 ms
  rec end → rec start (nothing heard): n=19 min=40 med=60 max=120 ms
  errors: none
  verdict: kept restarting for 5 min, 37 cycles
  log (last 25, 212 earlier not copied):
    +298.10s rec:start
    +298.62s rec:audiostart
    …
[p7] 7 · Command word · runs 4
  <app name> · 1 m · fan off: 8/10 token, 1 split, 0 alt-only, 1 miss · heard "tab tivity"×1 "activity"×1
```
Every probe that ran gets a block: its notes in full, plus the last 25 log
lines. The text also appears in a box under the bar, for copying by hand
when the clipboard refuses.

Gotchas:
- **`silence.wav` is served as `application/octet-stream`.** The
  `build.rs` mime table (`generate_mobile_assets`) has no `wav` row, and
  the phone sends `nosniff`. Chrome's media stack normally sniffs the
  container anyway, but that is untested. Probe 3 `file` logs the served
  content-type and any `audio:error`. If it fails there, the fix is a
  `"wav" => "audio/wav"` row (a backend change: needs a cargo gate and a
  dev build). S0 did not touch it, since the plan says no step runs cargo.
- **The file is 6 s (48 KB), not "a few hundred bytes".** As far as I know,
  Chrome on Android shows no media notification and claims no media focus
  for a player shorter than about 5 s, so a short file would fail probe 3
  for the wrong reason. A `srcObject` stream has no duration and is not
  affected.
- CSP (checked in `host.rs`, non-desktop branch): `default-src 'self'`
  with no `media-src`. `data:`/`blob:` media are blocked: probe 3 listens for
  `securitypolicyviolation` and logs `CSP BLOCKED: media-src refused …`.
  The `'self'` file and `srcObject` need nothing from the CSP. The HEAD
  `fetch` is allowed by `connect-src 'self'`. Permissions-Policy already
  allows `microphone` and `on-device-speech-recognition` for self.
- The page bypasses `App` entirely: no pairing, no local lock, no API.
  Anyone who has both the cached flag and the URL sees a page that only
  talks to the phone's own browser.
- The service worker passes `/silence.wav` and the probe chunk through to the
  network (they are not precached). The probe needs the desktop reachable
  once to load.
- `start(track)` (probe 2, second button) is meant for the on-device
  recognizer. With on-device off, the page warns that the speech service
  hears nothing from a track on Android, as `voiceSession.ts` records.
- The probe drives raw recognizers rather than `startDictation`, because
  that function's own restart policy would hide the gaps being measured.

Gates (frontend, `scripts/gates.sh` on the diff): all selected passed — brand-check, `git diff --check`, `npm run lint` (0 errors), `npm run build` (tsc + desktop, mobile, web bundles; the probe is its own chunk `assets/voiceProbe-*.js`, `silence.wav` lands in `mobile-dist/`), vitest `--changed` 38 files / 329 tests passed. No Rust change, so no cargo gate.
`scripts/privacy-check.sh`: passed (5 paths). It treats `silence.wav` as text (control bytes under 1 %), so it scans the file's lines; the reviewed-binaries line is recorded anyway, as the plan asks.

Flagged for user:
- The `.wav` content-type above: whether to add the `build.rs` row now or
  only if probe 3 `file` fails.
- The 6 s file length versus the plan's "a few hundred bytes".
- `voiceSession.ts` now exports three helpers, a small change in a file
  S3 owns.
- Never run on a phone; nothing here is verified live.

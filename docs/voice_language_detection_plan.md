# Desktop dictation: detecting the speech language — plan

> **Status: landed on develop (2026-11-22, ..a8590fa0f), never live.** Gates skipped
> at the user's request after partial runs; real-model tests and step 4's
> numbers not run (no model in the fence). Handoff:
> `docs/voice_language_detection_handoff.md`.

## Why

The speech language setting (`voice_lang`, Settings → Voice and the Chat's
dictation strip) offers **Automatic (app language)** (the default), one fixed
language, or **Let the model guess** (`detect`; `voiceLangTag` in
`src/lib/voice/desktopVoice.ts` sends it to the backend as `auto`). A bilingual
user has to switch the picker every time they change language.

Three problems stop `detect` from being the answer today:

1. **It returns no text at all (bug).** `stt.rs` handles `auto` with
   `params.set_detect_language(true)`. In whisper.cpp 1.8.3 that flag means
   *detect only*: `whisper_full_with_state` clears the results, detects, and
   `if (params.detect_language) return 0;` (whisper.cpp:6824) before it
   decodes anything. `full` then returns `Ok` with no segments, the session
   sees an empty text, `phantom::keep` drops it and the final goes out as
   `filtered`, not as an error. Every final comes back empty. No test catches
   it: the `stt.rs` tests check `whisper_lang`, not a real run. It has been
   this way since `3dffe6823`. (A null or `"auto"` language already means
   "detect, then decode" in the same function, so `set_language(None)` is the
   whole fix.)
2. **Too many languages to choose from.** Whisper picks the best of its ~99
   languages. On a short phrase, German drifts to Dutch or Afrikaans and
   Italian to Spanish or Portuguese. The help text's warning ("often fails on
   short phrases") is about this.
3. **Every segment guesses again, and nothing hears the result.** Each final
   is detected on its own, so one dictation can change language partway
   through. The detected language is thrown away: voice commands
   (`editLanguage`, `TerminalReaderView.tsx:764`) and read-aloud
   (`ReaderReadAloud.ts:85`) fall back to the UI language whenever the
   choice is `detect`.

## The design

Pick among a few languages the user actually speaks, keep that language for
the session, and report it.

- **Candidates.** The request carries a short list of whisper codes
  (`langs`, at most 5, primary subtags, deduplicated, each known to whisper).
  For a final while the session is not yet locked: `state.pcm_to_mel(audio,
  threads)`, then `state.lang_detect(0, threads)`. That gives the full
  probability vector (indexed by whisper language id). Pick the
  highest-scoring candidate and renormalise its probability over the
  candidates. Then run `full` with that language set, so whisper does not
  detect again.
  - **Checked against whisper.cpp 1.8.3:** `full` recomputes the mel itself
    and overwrites `state->mel`, and its own `auto` path runs the same
    `whisper_lang_auto_detect_with_state` on the same state before decoding.
    So detect-then-`full` on one `WhisperState` needs no reset; the only
    extra is a second mel (milliseconds).
  - **Cost:** whisper's built-in `auto` already encodes twice (one encoder
    pass in the detect, one in the decode loop), so this costs no more than
    `detect` costs now. After the lock it costs nothing extra.
  - **Not abortable:** `lang_detect` runs the encoder with no abort callback,
    so the session's `cancel` flag does not stop it (one encoder pass, finals
    only). Check `cancel` after it and return the error before `full`.
  - **GPU guard:** while `unproven` is set, the detect pass is the first GPU
    compute, so `gpu::arm()` goes before it and `disarm()` after `full`: one
    guard around both. `unproven` is cleared by `full`'s outcome, as now.
- **Where it runs.** Only on a `Job::Final`. The worker also calls
  `transcribe(.., false)` for a partial job's seam prefix, so `partial: bool`
  cannot mean "this is a final". Add `Transcriber::transcribe_final(audio)`
  with a default body that calls `transcribe(audio, false)`; the worker's
  `Job::Final` calls it and `Whisper` overrides it to detect. Seam prefixes
  and partials never detect: they use the locked language, else the last
  pick, else the start language.
- **Lock.** Lives in the worker (`Whisper`), not the session thread: the
  worker runs finals and partials in order, so it needs no message back and
  cannot race a partial that starts before the session thread handled the
  final's `Done`. The policy is a pure `LangPicker` in a new
  `services/voice/lang.rs` (compiled in every build, so CI tests it without
  whisper). It locks on the first final that (a) has at least
  `LOCK_MIN_SPEECH_MS` (1500) of audio (the VAD already cut the trailing
  silence to 200 ms, so audio length is the speech length), (b) has a
  renormalised top probability of at least `LOCK_MIN_P` (0.6), and (c) was
  kept: `phantom::keep(text, no_speech, prompt)` is `Some`. A filtered final
  never locks and its pick is not remembered. After the lock nothing detects;
  before it, every final does.
- **One candidate.** No detect pass; the session is locked from the start on
  that language, and `voice:lang` goes out just before the first transcribed
  final.
- **Params.** The comment on `Whisper` says each setter leaks a C string and
  the language setter panics on a NUL. `FullParams` is `Clone` (a shallow
  copy; the pointer is shared, nothing is freed) and its fields are private to
  whisper-rs. So build one `final`/`partial` pair per candidate up front (at
  most 10 `set_language` calls, a few leaked bytes each, per session) and
  choose between them. Candidates come through `whisper_lang`, so no NUL can
  reach the setter. Never call `set_language` per run.
- **Report.** A transcribed final's `TextEvent` gets `lang` (the whisper code
  it was decoded in). When the lock happens, a new `voice:lang` event
  (`{ session, lang }`) goes to the owner, just before that final. The
  frontend keeps the session's language: `editLanguage` and the command
  matcher use it, and the dictation strip shows a chip "Heard as Deutsch".
  Tapping the chip opens the existing picker, which already restarts the
  session in the language chosen.

## Steps

### Step 0 — fix `detect` (independent, ship first)

`stt.rs` `Whisper::load`: for `auto`, call `params.set_language(None)` (a null
language is whisper's "auto"; `Some("auto")` works too but leaks a string) and
never call `set_detect_language`. `FullParams`' fields are private, so a unit
test cannot read `detect_language`. Instead add an `#[ignore]` real-model test
(`VOICE_TEST_MODEL`, plus a speech clip named by `VOICE_TEST_WAV`, kept
outside the repo: a binary in the tree needs a `privacy-reviewed-binaries.txt`
entry) that runs `Whisper::transcribe` with `lang: "auto"` and asserts
non-empty text. Run `backend:stale`. No UI change, so no new `UntestedTag`;
the picker's row `terminal.reader.voice.langPicker` already exists. Manual QA:
pick **Let the model guess**, dictate a sentence, and text appears.

### Step 1 — pick among the candidates (backend)

- `ListenRequest`/`SessionConfig`: add `langs: Vec<String>` (empty means none)
  and `fallback: Option<String>`. `validate` follows the contract below.
  Update the struct literals in `commands/voice.rs` and the `mod.rs` and
  `session.rs` tests.
- `lang.rs` (new, pure; `#[cfg_attr(not(feature = "voice"), allow(dead_code))]`
  on what only `stt.rs` uses, as `gpu.rs` does): `pick(probs: &[f32],
  candidates: &[i32]) -> (usize, f32)`, the candidate's index and the
  renormalised p, with unit tests: probability mass on a non-candidate is
  ignored, a tie keeps the first candidate, all-zero gives the first
  candidate with p 0, an id past the vector counts as p 0. `LangPicker` (the
  lock policy above) with its tests. Update the `voice/` row in
  `docs/filemap_backend.md`.
- `stt.rs`: the per-candidate params table, `transcribe_final`, detection on
  unlocked finals. `whisper_lang` on every candidate in `load` (a failure is
  `BadArgument`, as today). `Transcript.lang` is the candidate used or, for
  open `auto`, `whisper_rs::get_lang_str(state.full_lang_id_from_state())`.
- A failed `lang_detect` or `pcm_to_mel` falls back to the last pick, else the
  start language. It never fails the final.

### Step 2 — the session lock (backend)

- `Transcript` gets `lang: Option<&'static str>` and `locked: bool` (true on
  the one final that locked). Its construction sites (the worker's echo
  answer, the test fakes, `stt.rs`) go through a `Transcript::plain(text,
  no_speech)` constructor.
- `Listener::done` on a `Transcribed` final: if `locked`, emit `voice:lang`
  (`EV_LANG`) first, then the `voice:final` with `lang`. Not on an aborted
  session, not on a filtered final.
- `session.rs` tests with a fake transcriber that overrides `transcribe_final`
  to return `lang`/`locked`:
  - the final carries `lang`;
  - `voice:lang` precedes the locking final and is emitted exactly once;
  - a seam-prefix run and a partial never call `transcribe_final`.
  The lock policy itself is `lang.rs`' tests: a short first final does not
  lock; a long, confident, kept one does; later finals do not detect; a
  filtered one does not lock.

### Step 3 — report it (frontend)

- `desktopVoice.ts` (a `lib/` file; its raw `listen` is allowed, the lint rule
  covers `src/components/` only): add `VOICE_EVENTS.lang` and a `LangEvent`;
  `FinalEvent` gets `lang?`; `onFinal(text, segment, filtered, lang?)` and a
  new `onLang(lang)` handler. Send `langs`/`fallback` only when set.
- `useLiveDictation`/`ReaderVoice.tsx` hold `spokenIn` in a **ref**, set
  synchronously from `onFinal`'s `lang` and `onLang`, and cleared when a
  session starts (D3). `dictated(heard, segment)` runs in the same tick as the
  final, where a state value would still be the previous segment's. Only an
  app language counts (`LANGUAGES`); do not pass it through `normalizeLang`,
  which turns "nl" into `en`.
- `TerminalReaderView.tsx:764`: when the choice is `detect`, `editLanguage`
  is `spokenIn ?? uiLanguage`; the matcher at `:991` takes the final's own
  `lang` first.
- `ReaderVoice.tsx`: the "Heard as …" chip, only under `detect` and after
  `voice:lang`. `start()` builds `langs` from `voice_detect_langs` when the
  choice it starts with is `detect` (`switchLang` passes the new choice, so
  read the argument, not the stored setting).
- `VoiceSettings.tsx`: the candidate checkboxes (D2) under the picker when
  `detect` is chosen; 1 to 5 of the app languages, the last one cannot be
  unchecked; they apply from the next session. Update the
  `settings.voice.langDetect`/`langHelp` copy: it now means "pick among
  these". The dictation strip gets no checkboxes.
- `ReaderReadAloud.ts:85` (D5): under `detect`, read aloud in the tab's last
  locked language (a module-level `Map` keyed by tab key in `lib/voice`, in
  memory, written on `voice:lang`), else the UI language.
- New i18n keys (chip, checkboxes, help) in all five dictionaries,
  `UntestedTag` with a row in `src/lib/untested.ts` for the chip and the
  checkboxes; a row in `docs/filemap_frontend.md` for any new file.
- Tests: the matcher follows the final's `lang`; the chip renders on
  `voice:lang`; `langs` is sent only under `detect`; `DesktopVoice.test.ts`'s
  expected `invoke` arguments.

### Step 4 — tune and decide the default

An `#[ignore]` Rust test runs when the model file (`VOICE_TEST_MODEL`) and a
fixture directory (`VOICE_TEST_WAVS`, outside the repo, joined with
`Path::join`) are present. It feeds short German and English clips (2–4 s; the
user records them, or uses Parakeet's step 0 `test_wavs`) through open
detection and through candidate detection with `small` and `large-v3-turbo`,
and prints the pick, p and whether it locked. The numbers set
`LOCK_MIN_SPEECH_MS`/`LOCK_MIN_P`. Then D4.

## Fixed decisions (user, 2026-11-22)

Reviewers may not undo these.

- **D1 Step 0 is its own commit**, first in agent A's range.
- **D2 Candidate set:** a new setting `voice_detect_langs`, shown as
  checkboxes under the picker when "detect" is chosen, defaulting to the UI
  language + English (deduplicated), editable, 1–5 entries from the app
  languages.
- **D3 Lock scope:** per session. A new session detects again; switching
  language means stopping and starting dictation.
- **D4 Default:** keep "Automatic = UI language" until step 4's numbers and
  live QA, then decide whether Automatic becomes candidate detection.
- **D5 Read-aloud under `detect`:** the tab's last locked language, else the
  UI language. The frontend keeps it per tab: in memory, not persisted.

## Contract between backend and frontend (fixed before agents start)

- **`voice_listen_start`** gains two optional arguments (camelCase on the
  wire): `langs: Option<Vec<String>>` (the candidates; absent or empty = none)
  and `fallback: Option<String>`. `ListenRequest::validate` refuses: more than
  5 candidates (counted before deduplication), any one failing `valid_lang` or
  equal to `auto`, non-empty `langs` with `lang` other than `auto`, a bad
  `fallback` (`auto` included). Candidates are reduced to primary subtags and
  deduplicated; one whisper does not know fails the session's load with the
  existing error, as a bad `lang` does today. `fallback` only chooses among
  the candidates: it is what partials and a failed detect use before any pick
  when it is a candidate, else the first candidate. With no candidates it is
  ignored.
- **`lang` = `auto`, no candidates** (an older renderer): whisper's open
  detection per segment, after step 0's fix; no lock, no `voice:lang`.
- **One candidate:** no detection; it behaves as that language forced, plus
  one `voice:lang` before the first transcribed final.
- **`voice:final`** gains `lang?: string`, the lowercase whisper code
  (`"de"`) the segment was decoded in. Present exactly when `outcome` is
  `transcribed`: a forced-language session sends its language, an open `auto`
  one the language whisper detected (it may be outside the app languages), a
  candidate session the pick or the lock. Absent on `filtered`, `failed` and
  `incomplete`, and from a backend older than this change.
- **`voice:partial`** is unchanged: no `lang`.
- **`voice:lang`** (new, `EV_LANG`, to the owner like the text events):
  `{ session, lang }`. Sent only for a candidate session, exactly once, when
  it locks, immediately before the `voice:final` of the segment that locked
  it (that final carries the same `lang`). Never for a forced-language or
  open-`auto` session.
- **What B does with it.** A session started with a forced language (any
  choice but `detect`) gets `lang` on its finals and never `voice:lang`: B
  ignores both there (`editLanguage` is the choice; no chip; nothing stored
  for D5). Under `detect`, `spokenIn` is the latest transcribed final's `lang`
  if it is an app language, else unchanged; the chip and D5's per-tab memory
  follow `voice:lang` only. B must not assume a `voice:lang` ever arrives
  (short sessions, an older backend): no chip, and `editLanguage` falls back
  to the UI language.
- **Setting** `voice_detect_langs?: string[]` (renderer-only; the backend
  round-trips it through the settings catch-all like the other `voice_*`
  keys). Unset or empty: `[uiLanguage, "en"]` deduplicated. Only app languages
  count; at most 5. B sends it as `langs`, and the UI language as `fallback`,
  only when the chosen language is `detect`.

## Agent steps

| Agent step | Plan sections | Files |
|---|---|---|
| **A: backend** | Steps 0, 1, 2, and step 4's `#[ignore]` test | `services/voice/stt.rs`, `session.rs`, `mod.rs`, new `lang.rs`, `commands/voice.rs`, `docs/filemap_backend.md` row |
| **B: frontend** | Step 3, D2's setting UI, D5 | `lib/voice/desktopVoice.ts`, `components/terminal/ReaderVoice.tsx`, `useLiveDictation.ts`, `TerminalReaderView.tsx`, `ReaderReadAloud.ts`, `components/layout/VoiceSettings.tsx`, `types/index.ts`, i18n ×5, `lib/untested.ts`, tests, `docs/filemap_frontend.md` row |

The split holds: no shared file, and B builds against the contract alone (its
tests mock `invoke`/events). No new Tauri command, so no `command_class` row.
`docs/context/voice.md` has a subsystem rationale doc, and another session
has uncommitted edits in it; so do `docs/filemap_frontend.md`,
`src/lib/untested.ts`, the i18n dictionaries and `lib/voice/voiceCommands.ts`.
A writes its `voice.md` paragraph in the handoff instead of editing it; B adds
its i18n keys, register rows and filemap row at the end of the existing
blocks, so the main agent's merge of the other session's edits stays trivial.
Gates: A runs the Rust gates including both no-default-features ones (`lang.rs`
and the new `Transcriber` method must build without `voice`); B runs
`npm run build`, `npm test`, `npm run lint`, `scripts/brand-check.sh`.

## Organisation

- **Shape:** disjoint subsystems once an interface is fixed. The contract
  above is the interface.
- **Run:** plan reviewer (1) → A ∥ B, each in its own worktree reset to
  `develop` (2) → final reviewer over the integrated range, bugs only (1).
  Four subagents in all, at most two at once.
- **Why it fits:** A (Rust, whisper FFI) and B (TS UI) share no file. The
  risky part, the whisper FFI and the session lock, gets the final
  reviewer's first attention.
- **Handoff:** `docs/voice_language_detection_handoff.md`. A writes only
  under `## A`, B only under `## B`, so the two merge cleanly.

## Out of scope

- **Phone.** Phone dictation uses the browser's speech recognizer
  (`mobile-web/src/voiceSession.ts`). It has to be told one language up front
  and cannot detect one; Chromium's on-device model does the same. Detection
  there would mean sending phone audio to the desktop's whisper, which is a
  separate feature.
- **Parakeet** (`docs/parakeet_plan.md`) detects the language per utterance
  on its own, and these candidates do not apply to it. Step 3's reporting
  (`lang` on finals, `voice:lang`) is engine-neutral, so Parakeet can feed it
  if its runtime reports a language.

## Manual QA (🖐️, never live yet)

1. **Let the model guess**, dictate one English sentence: text appears (step 0).
2. Candidates de+en, say "Öffne die Datei" (short): German text, no Dutch;
   the chip appears once a longer sentence locks.
3. Locked on German, say an English sentence: it is transcribed as German. A
   lock is a lock; the chip's picker is the way out.
4. Under `detect`, a German voice command ("lösche das letzte Wort") works once
   the session has locked on German.
5. One candidate only: no detection pause on the first sentence, and the
   chip shows with its first text.
6. Read an answer aloud after a German lock, then start a new session: the
   voice stays German (D5) until the next lock.

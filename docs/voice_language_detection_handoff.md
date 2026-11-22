# Voice language detection — handoff

Plan: `docs/voice_language_detection_plan.md`. Each agent edits only its own
section: shas, choices made, gotchas, gate status with test counts, "Flagged
for user".

## A

Backend, steps 0, 1, 2 and step 4's ignored test. Branch of worktree
`agent-a74e9ee931e432248`, on top of `e2cd38b20`.

**Commits**
- `5da700b11` step 0 (D1, own commit): `auto` now calls `set_language(None)`;
  `set_detect_language(true)` is gone. Ignored test `open_detection_returns_text`.
- `34ef3c7e1` steps 1-2 + step 4's test: `lang.rs`, `ListenRequest`/`SessionConfig`
  `langs`/`fallback`, `Transcriber::transcribe_final`, `Transcript.lang`/`locked`
  and `Transcript::plain`, `EV_LANG`, per-candidate params in `stt.rs`, the
  `voice_listen_start` arguments, filemap row, ignored `language_detection_numbers`.
- the handoff commit (this file).

**Choices**
- Contract implemented as written. `voice_listen_start` takes
  `langs: Option<Vec<String>>`, `fallback: Option<String>` (camelCase on the wire).
- `validate` (`check_langs`): more than 5 (before dedup), `auto` or a bad tag in
  `langs` or `fallback`, non-empty `langs` with `lang != "auto"` are `bad-argument`.
  Candidates are reduced to primary subtags and deduplicated; a fallback without
  candidates is dropped; a fallback that is not a candidate is kept and `stt.rs`
  resolves it (the first candidate runs then).
- `LangPicker` works by candidate index, not whisper id. `finished(used, p,
  speech_ms, kept)` returns true exactly once, on the final that locked (or, for a
  single candidate, on its first kept final). A filtered final changes nothing.
- `Whisper::transcribe_final` runs `pcm_to_mel` + `lang_detect(0, threads)` +
  `lang::pick`, one `gpu::arm`/`disarm` around detect and `full` (`guarded`).
  After detect it returns `ModelFailed` when `cancel` is set (detect itself cannot
  abort). A failed mel/detect falls back to `picker.current()` with p 0.
- `Transcript.lang` is set on every run (also partials, harmless: partial events
  carry no `lang`). Open `auto` reads `full_lang_id_from_state`.
- Only a candidate session ever sets `locked` and sends `voice:lang`
  (`Whisper.candidates`); a forced-language or open-`auto` session sends `lang` on
  its transcribed finals only.
- `Listener::done`: `lang` is attached only when the final is kept
  (`Transcribed`); `voice:lang` is emitted just before it when `locked`.
  An aborted session returns earlier, so nothing goes out.
- Candidates whisper aliases to the same code (`jw`/`jv`) are deduplicated in
  `candidate_codes` after `whisper_lang`.
- `LOCK_MIN_SPEECH_MS = 1500`, `LOCK_MIN_P = 0.6` are untuned starting values.

**Gotchas**
- No whisper model exists in this fenced tab: all three real-model tests
  (`a_real_load_says_where_it_landed`, `open_detection_returns_text`,
  `language_detection_numbers`) are written, compile, and were NOT run. Step 0's
  fix and detect-then-`full` on one state are unverified live (the plan checked
  them in whisper.cpp 1.8.3's source only).
- `scripts/gates.sh` with a clean tree runs nothing; I ran `gates-job.sh start
  --base e2cd38b20` for the whole range.
- `npm run backend:stale` printed nothing in the worktree.
- The first whisper compile in a fresh worktree takes ~13 min.
- Run the numbers test: `VOICE_TEST_MODEL=<small.bin>:<large-v3-turbo.bin>
  VOICE_TEST_WAVS=<dir of <lang>_x.wav> cargo test -p tabtivity --lib --
  --ignored --nocapture language_detection_numbers` (optional `VOICE_TEST_LANGS`).

**`docs/context/voice.md` paragraph (for the main agent to add)**

> **Language detection (desktop whisper).** `lang: "auto"` is whisper's open
> detection per segment: `FullParams::set_language(None)`, never
> `set_detect_language(true)`, which means detect only and returns no text.
> With `langs` (at most 5 whisper codes, from the `voice_detect_langs` setting)
> a session picks among them: only a `Job::Final` (`Transcriber::transcribe_final`)
> runs `pcm_to_mel` + `lang_detect` and takes the best candidate's renormalised
> probability (`lang::pick`); partials and seam prefixes use the locked
> language, else the last kept pick, else the fallback. `LangPicker` (worker
> side, `lang.rs`) locks on the first kept final with at least 1500 ms of audio
> and p >= 0.6; later finals do not detect (a lock is a lock, per session). One
> candidate is locked from the start. `voice:final` carries `lang` when
> transcribed; `voice:lang { session, lang }` goes out once, just before the
> final that locked, candidate sessions only. Params are built once per
> candidate (each setter leaks a C string); `lang_detect` is not abortable, so
> `cancel` is checked after it.

**Gate status:** skipped at the user's request after the run below was stopped.
Seen passing on `--base e2cd38b20` (tree at the clippy fix commit): brand-check,
`git diff --check`, `cargo clippy -p tabtivity -p app-serverd --all-targets`,
`cargo clippy -p tabtivity --no-default-features --lib` (the daemon's build, so
`lang.rs` and `transcribe_final` build without `voice`),
`cargo clippy -p app-serverd --all-targets`, and `cargo test -p tabtivity -p
app-serverd` (full suite, PASS). Not finished: the no-default-features test run
(`--lib --test server_secrets`, killed). Before that, `cargo test -p tabtivity
--lib voice::` gave 104 passed, 0 failed, 2 ignored (the real-model tests; 3
now, with the numbers test). Frontend gates not applicable (no frontend change).

**Flagged for user**
- Nothing in the Contract was wrong. Open items: the real-model tests have not
  been run (needs a model and clips); the thresholds are guesses until step 4's
  numbers; the first dictation after the lock-less start still guesses per final.

## B

Branch `worktree-agent-a48d6fb43d2f64461`, three commits on top of `e2cd38b20`:
`a854c80ed` (desktopVoice client + `voice_detect_langs` type), `fb204e256`
(dictation, chip, matcher, read-aloud), `18ca90677` (Settings checkboxes, copy,
register, search index, filemap). The handoff itself is the fourth.

**Built against the Contract, as written.**
- `desktopVoice.ts`: `VOICE_EVENTS.lang`, `LangEvent`, `FinalEvent.lang`;
  `onFinal(text, segment, filtered, lang?)` and an **optional** `onLang?(lang)`;
  `DesktopDictationOptions.langs?/fallback?` go into the `voice_listen_start`
  args only when `langs` is non-empty. New helpers: `appLanguage`,
  `detectLangs` (stored app languages, deduped, max 5, else `[ui, "en"]`),
  `voiceCandidates(choice, stored, ui)` (`{}` unless `detect`; `fallback` is
  the UI language when it is a candidate, else the first), and
  `rememberSpokenLang`/`lockedSpokenLang` (module `Map` by tab key; D5).
- `ReaderVoice.tsx`: `start()` sends the candidates from the choice it was
  *given* (so `switchLang` works), sets `sessionDetect`, clears `spokenIn` and
  the chip. `onFinal` sets `spokenIn` synchronously before the text is handled,
  only for a `detect` session and only for an app language. `onLang` sets
  `spokenIn`, the chip and the per-tab memory, only for a `detect` session.
  Forced-language sessions ignore both (as the Contract says).
- `spokenIn` is a `useRef` **owned by `TerminalReaderView`** and passed to
  `useReaderVoice` (the view needs it before the hook is called, for
  `useLiveDictation`). `editLanguageOf()` = forced choice, else (under
  `detect`) `spokenIn.current`, else the UI language. `useLiveDictation`'s
  `language` prop is now a getter `() => Language`, so partials and finals both
  read the live value (a stale render value would lag one segment).
- Chip: "Heard as {lang}" button in the picker row next to the language
  dropdown (`.settings-btn`, no new CSS); click clicks the dropdown's trigger,
  i.e. opens the existing picker. Appears only after `voice:lang`.
- `ReaderReadAloud.ts` takes a new `tabKey` argument; under `detect` it reads in
  `lockedSpokenLang(tabKey) ?? uiLanguage`.
- `VoiceSettings.tsx`: a checkbox row (`settings.voice.detectLangs`) when
  `voice_lang === "detect"`; the last ticked box is disabled; saves
  `voice_detect_langs` in app-language order. Row added to `settingsIndex.ts`
  and `docs/help/settings-links.md` regenerated (a test checks both).
- `src/styles/subwindows.css`: `.settings-voice-langs` (flex wrap).

**New i18n keys** (all five dictionaries): `settings.voice.detectLangs`,
`settings.voice.detectLangsHelp`, `terminal.reader.voice.heardAs` (`{lang}`),
`terminal.reader.voice.heardAsHelp`; reworded `settings.voice.langDetect`
("Pick among my languages") and `settings.voice.langHelp`.
**New untested ids** (`src/lib/untested.ts`): `terminal.reader.voice.heardAs`,
`settings.voice.detectLangs`.
**Filemap rows touched** (`docs/filemap_frontend.md`): `VoiceSettings.tsx`,
`ReaderVoice.tsx + desktopVoice.ts`, `ReaderReadAloud.ts`. No new source file.

**Tests added.** `DesktopVoice.test.ts` (args with/without `langs`, `lang` on
finals, `voice:lang`, helpers), `ReaderVoice.test.tsx` "speech language
detection" (candidates sent only under detect; matcher follows the final's
`lang`; non-app language and forced choice ignored; chip on `voice:lang`, opens
the picker, cleared at session end), `ReaderHandsFree.test.tsx` (read-aloud
language), new `VoiceSettings.test.tsx` (checkboxes).

**Gotchas.**
- Spoken-edit tests need `loadDict("de")` first; the matcher reads the loaded
  dictionary.
- `lang` on a final is ignored unless it names an app language (`LANGUAGES`);
  Whisper may report e.g. `nl` under open `auto`, which then falls back to the
  UI language for edits.
- The chip lives in the picker row, which shows only while listening/preparing,
  so it disappears with the session (as `heardAs` is cleared in `reset()`).
- `VoiceSettings`' natural-voice install still keys on the UI language under
  `detect` (it is a global setting; the per-tab lock is only for read-aloud).
- The worktree's `git commit` prints a "MOBILE BUNDLE IS STALE" notice; unrelated.

**Gates** (`scripts/gates-job.sh start --base e2cd38b20`, whole branch): brand
PASS, whitespace PASS, lint PASS (no new warnings), `npm run build` PASS,
vitest PASS: 957 test files, 9663 tests (957 of 1273 files affected; the
earlier run failed only `SettingsLinkCatalog`, fixed by regenerating
`docs/help/settings-links.md`). Rust gates were selected by the base diff but
are agent A's territory; no Rust file is touched by B.

**Flagged for user.**
- Nothing in the Contract was wrong. One interpretation: the chip is not a
  separate control that opens a hidden picker, since the picker row is always
  visible while listening; the chip programmatically opens that dropdown.
- Read-aloud keeps the lock per tab in memory only, so a reloaded window starts
  at the UI language until the next lock (D5 as written).
- Not live-verified: both new UI pieces wear `UntestedTag`.

## Final review

(not started)

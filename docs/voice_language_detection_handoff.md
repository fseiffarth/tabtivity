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

**Gate status:** see below.

**Flagged for user**
- Nothing in the Contract was wrong. Open items: the real-model tests have not
  been run (needs a model and clips); the thresholds are guesses until step 4's
  numbers; the first dictation after the lock-less start still guesses per final.

## B

(not started)

## Final review

(not started)

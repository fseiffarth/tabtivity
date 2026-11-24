# Mail autocomplete — backend handoff (agent step A)

Branch `worktree-agent-a167fd269ac6468b2` (worktree
`.claude/worktrees/agent-a167fd269ac6468b2`), started from develop `b1206dc13`.
Plan: `docs/mail_autocomplete_plan.md`. Commit shas: see the end of this file
(filled in by the last commit's message and `git log`).

## What was built

- `services/mail/mail_complete.rs` (+ `mail_complete/tests.rs`, 28 tests):
  `Status`, `MailComplete` (wire shape of the Contract), `Account`, `Original`,
  the prompt builder (`[system, context, "OK", draft]`; warm = `[system, context]`),
  `above_quote` + `windowed` + `shape_draft`, `cut_sentence` (abbreviations:
  dotted initials like `e.g`/`p.m`, plus a short list `Dr`, `Mr`, `ca`, …),
  `cap_at_word` (100), `has_link`, the slot `Table`, and the three entry
  points `gate` / `fill` / `run` (+ `release`).
- Engine shape (a deliberate choice, see "Choices"): `gate` runs every refusal
  up to and including the endpoint probe and returns `Done(answer)` or
  `Ready`; the command reads the original (async, 6 s on a completion) only for
  a `Ready` that `needs_original()`, hands it to `fill`, then `run`s. The probes
  (`store_locked`, `account`) are closures asked in gate order, which is how
  the tests pin "nothing is asked after a refusal".
- `commands/mail.rs`: `fetch_message_text` split into
  `fetch_message_text_with_crypto` (unchanged behaviour; the old name wraps it),
  `fetch_message_context` (body cache first, else IMAP; encrypted ⇒ body `None`),
  `complete_inner`, and the three commands (`mail_ai_complete_warm`,
  `mail_ai_complete`, `mail_ai_complete_release`), registered in `lib.rs`,
  rows in `services::command_class`, `src/lib/transport/commandClasses.ts`
  regenerated (the only TS file touched).
- `schema/mail.rs`: `MailAiPrefs.autocomplete: Option<bool>` + `is_empty` + a
  round-trip test.
- `mobile_control`: `DesktopRequest::MailComplete` / `DesktopResponse::MailComplete`
  (request id, not a mutation, 20 s / 16 s), `MAX_MAIL_COMPLETE_BYTES` (8 KiB),
  route `POST …/messages/{m}/complete` (16 KiB body limit), host test, and the
  route added to the unauthenticated and hidden-section lists.
- Visibility only: `next_prompt::inert` and five `mail_ai::*_reason` fns are
  `pub(crate)` now.
- Docs: `docs/context/mail_ai.md` (new), `docs/filemap_backend.md` row,
  `docs/threat_model.md` ("Pair a phone" row), `docs/context/agent_reader.md`
  (see-also sentence), `todo/group-q-mail-ai.md` (QA-ACa..d with the platform
  box pairs), `todo/group-j-mail.md` #202 annotated done.

## Choices

- **Three-step engine instead of one call.** The original is read with async
  IMAP code that must not run under the blocking pool's thread; so the
  command awaits it between `gate` and `run`. Statuses and order are the
  Contract's.
- **`locked` returns before the account is read** (the Contract's "account read
  failed while locked" is subsumed).
- **Busy / generation bump sit after the account step, before the endpoint
  probe**, so a newer completion ends the older run before its own probes.
  A warm-up does not bump the generation.
- **Link rule is strict**: `://`/`www.` anywhere in the cleaned (≤ 120 char)
  continuation drops the suggestion, even when the sentence cut would have
  removed it.
- **Sentence terminator**: `.`/`?`/`!` followed by whitespace or the end; a
  `.` after an abbreviation (list above, or dotted segments of ≤ 2 letters) is
  skipped. A draft that already ends in a terminator is still completed (the
  next sentence), D1 not special-cased.
- The `identity` field of the plan's `SlotState` is not stored: the account is
  read on every request anyway, so the signature/name are always fresh.
- `Abort` is registered under the table lock together with the generation
  check, and `ollama_http_abortable` never sends on an already aborted handle,
  so a superseded request cannot leak a request to Ollama.

## Contract deviations

None in names, args, statuses or wire shapes. One addition: the route also
forces `text: null` for any status but `ok` (the Contract only says text is
`null` except with `ok`).

## Gotchas

- Host tests are `#[cfg(unix)]` like the sibling next-prompt tests.
- `Status` is `Deserialize` because the sidecar parses the window's outcome
  word with it (unknown ⇒ `unavailable`).
- The test target takes 12 min cold on this machine (load average ~65 from
  other sessions).
- `commandClasses.ts` was regenerated with the documented command; the frontend
  agent should not hand-edit it.
- `mail_ai.rs` still has its private single-message `chat_with`; only reason
  strings were made `pub(crate)`.

## Gates

`scripts/gates-job.sh start` (changed-files selection), all PASS at zero warnings:
brand, whitespace, `npm run lint`, clippy (`-p tabtivity -p app-serverd --all-targets`),
clippy daemon build (`--no-default-features --lib`), clippy `app-serverd`,
`npm run build`, vitest `--changed`, `cargo test -p tabtivity -p app-serverd`
(705 s), `cargo test -p tabtivity --no-default-features --lib --test server_secrets`.
New tests: 28 in `mail_complete/tests.rs`, 1 host route test, 1 schema
round-trip test; `the_generated_command_classes_ts_is_current` passes after
regeneration. The run ended with "tree changed while they ran": only this
handoff file was added meanwhile (docs-only).

## Flagged for user

- `mail_formalize_reply` / Summarize still read a *decrypted* original; D6
  makes autocomplete stricter. Decide whether they should follow D6.
- `Original` holds up to 3000 chars of a plain mail's body per composer slot
  in process memory (≤ 4 slots, 10 min); accepted by the plan, never written.
- First-suggestion latency on a ~2k-token original was not measured (the app
  was not run); the 5 s run budget may be too short for a cold model, which
  then reads as `unavailable` and a 60 s frontend back-off.
- Never run live: neither the desktop composer nor the phone path, nor the
  window's `mailComplete` (frontend half).

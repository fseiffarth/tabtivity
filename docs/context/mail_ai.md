# Mail AI (local) — reply autocomplete, as built

The Group Q assistant (`services/mail/mail_ai.rs`: summarize, classify,
formalize, extract) is described in `todo/group-q-mail-ai.md`. This file holds
the reply **autocomplete**: the Mail-role model finishes the sentence being
typed, from the mail being answered. Plan and decisions D1–D6:
`docs/mail_autocomplete_plan.md`. Never live-tested.

## Shape

- Engine `services/mail/mail_complete.rs`, `AppHandle`-free. Three steps the
  commands (`commands/mail.rs`: `mail_ai_complete_warm`, `mail_ai_complete`,
  `mail_ai_complete_release`) chain: `gate` (blocking: every refusal, the
  endpoint probe) → `fill` (only when the slot lacks the original; the command
  reads it, async, 6 s budget on a completion, none on a warm-up) → `run`
  (blocking, 5 s). A user-visible failure is a `status`, never an `Err`.
- Gate order, each step asked only after the one before: shape (`skipped`) → AI
  switch → `mail_client` + `mail_ai_allow` (`off`) → Mail model (`no_model`) →
  store opened + `unlock_note` (`locked`) → account + `ai.autocomplete != false`
  (`unavailable` / `off`) → slot (`busy` for a warm-up) → `ollama_local::preflight`
  + capabilities (`refused` / `not_running`) → original → run. No IMAP, no
  Ollama chat before a refusal; unit-tested with a probe log.
- Prompt `[system, user#1, assistant "OK", user#3]`. `user#1` (account name,
  signature, the original or a new mail's subject/recipients) is its own
  message and byte-identical across drafts, so a hybrid model restores its
  checkpoint (same lesson as `next_prompt`, `qwen3.5:9b` 2026-11-23). `user#3`
  is the draft and the order to reply with a line beginning with the draft's
  last words (`next_prompt::draft_tail`); `next_prompt::continuation` checks it.
  A warm-up is `[system, user#1]`, `num_predict: 1`. Same options on every
  request (`temperature` 0.2, `num_predict` 64, no `num_ctx`), `think:false`
  when the model has `thinking`, `keep_alive` from `keep_alive_for`.
- The original (`Original`): subject, `From`, body cleaned per line
  (`next_prompt::inert`: control, bidi, zero-width out), `>` lines dropped,
  cut at a `-- ` line, blank runs folded, ≤ 3000 chars. **D6:** an encrypted
  original (`MailCryptoInfo.encrypted`) gets `body: None` and the prompt says
  "(the body is encrypted and not shown)". A body-cache hit proves the mail was
  plain (`body_inner` caches nothing with a crypto verdict). The draft is also
  cut at its first line starting with `>` in the backend, so a quoted original
  never crosses even if the client sent it.
- Output: `continuation` → drop on `://` / `www.` (checked on the whole cleaned
  line, before the cut: stricter than the shown text) → cut after the first
  `.`/`?`/`!` followed by whitespace or the end (a dotted number, `e.g.`,
  `p.m.`, `Dr.` do not end it) → ≤ 100 chars at a word boundary. `ok` with
  `text: null` when nothing is left.
- Slots: `Table`, ≤ 4 composers, LRU, 10 min idle TTL checked on access, an
  evicted/expired/released slot's run aborted. A completion bumps the slot's
  `generation` and aborts the run in flight; a request registers its
  `Abort` only if its generation is still current (checked under the lock), so
  a stale one never sends (`skipped`). A warm-up is `busy` while a run is in
  flight or within 2 s of the last. Memory only, never logged.
- Phone: `POST /api/v1/mail/folders/{f}/messages/{m}/complete` →
  `DesktopRequest::MailComplete` (not a mutation; 20 s / 16 s timeouts). The
  window resolves the opaque ids; with no window the answer is `unavailable`.
  The sidecar answers `text`/`status`/`model` only, re-cleans the text
  (`clean_completion`), and maps an unknown outcome word to `unavailable`.
- Setting: `MailAiPrefs.autocomplete` (absent ⇒ on; the one mail-AI toggle that
  defaults on). A build without the field keeps it in `extra`.

## Why

- The Ollama transport is not new: `ollama_http_abortable` against the address
  `preflight` returned. `mail_ai.rs` is untouched but for five `pub(crate)`
  reason strings; its `chat_with` is single-message, un-abortable.
- `mail_formalize_reply` and Summarize still read a *decrypted* original
  (`fetch_message_text` → `apply_crypto`); D6 makes autocomplete stricter than
  them. Open question for the user.
- Two requests racing to fill one slot's context may both read the original;
  bounded, left as is.

See also `docs/context/agent_reader.md` ("Prompt autocomplete"), the sibling for
agent prompts.

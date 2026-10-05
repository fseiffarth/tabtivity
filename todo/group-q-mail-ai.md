## Group Q — Local-Model Mail Assistant (on-device) · ✅ Implemented · 🧪 Untested

> **Status (reconciled 2026-09-14):** #203–#208 all landed 2026-07-30
> (`51a8e4b`, settings dialog `981987f`) and were never marked. Present in code:
> `services/mail_ai.rs` (14 unit tests), `mail_summarize` /
> `mail_formalize_reply` / `mail_extract_event` / `mail_extract_task` /
> `mail_ai_classify_apply` in `commands/mail.rs`, sealed
> `priority_source`/`priority_reason` columns in `mail_store.rs`, the 🧠 Mail
> role live (no `pending`), `MailAiMessageActions` / `MailAiSettings{,Dialog}`
> with `UntestedTag`. **One deviation from the plan below:** the toggles are
> **per account** (`MailAccount.ai: MailAiPrefs` — `summarize`, `autoclassify`,
> `formalize`, `calendar`, `todo`, `auto_create`) behind one global master
> switch `Settings::mail_ai_allow`, not five global `mail_ai_*` settings flags.
> The plan text below is kept as written; the manual checks are at the end.

*Five opt-in mail features driven by a **local** Ollama model: summarize a
message, auto-file it into Important/Urgent, formalize a reply from rough notes,
and extract a calendar event or a to-do card from it. This is the consumer that
Group J's **#202** reserved — the 🧠 menu's **Mail** role tag
(`MODEL_ROLES` in `LocalModelMenu.tsx`) ships with `pending: true` and nothing
reading it. The model is `ollama_roles["mail"] ?? ollama_model`.*

*The load-bearing invariant: the **AI path never touches the internet**. Mail's
own IMAP/SMTP transport does, but every prompt here runs against a **loopback**
Ollama and refuses a non-loopback host **even when `ollama_allow_remote_host` is
true** — stricter than the setting on purpose. No web fetch / image proxy / link
resolution inside any prompt; the only input is what the local store already
holds. The store/encryption invariants it must honour:
[`docs/context/mail_encryption.md`](../docs/context/mail_encryption.md).*

*Files: new `src-tauri/src/services/mail_ai.rs` (the loopback-only `/api/chat`
helper + prompt builders + defensive JSON parsers) and its commands in
`src-tauri/src/commands/mail.rs` (path-free, respecting `no_command_takes_a_path`);
`sync_inner` classify hook + a `priority_source`/`priority_reason` schema bump in
the mail store; `src-tauri/src/schema/settings.rs` (five `mail_ai_*` flags +
`mail_ai_auto_create`); `src-tauri/src/lib.rs` (`generate_handler!`). Frontend
`src/components/mail/{MailMessageView,MailComposeDialog,MailList}.tsx`,
`src/components/layout/LocalModelMenu.tsx` (drop `pending`),
`src/components/layout/SettingsPanel.tsx` (the "Mail AI (local)" section),
`src/lib/todoBoard.ts` (reuse `taskFromMail`), `src/lib/i18n.ts`,
`src/styles/themes.css`.*

203. **Shared foundation.** `services/mail_ai.rs`: `mail_ai::chat` — a wrapper
    over the existing `/api/chat` (`stream:false`, system+user, bounded
    `num_predict`, low temperature) that resolves the mail-role model, **enforces
    loopback** (reuse `host_is_loopback`, refuse a remote host regardless of
    `ollama_allow_remote_host`), refuses an **embedding-only** model with a
    "load a completion model" reason, and maps an unreachable server to the
    `not_running` sentinel. Empty/absent capabilities read as *unknown → allow*.
    Make the 🧠 **Mail** chip live (drop `pending: true` + the `roleNotWired`
    tooltip clause). Add the **"Mail AI (local)"** settings section holding the
    five toggles — all `Option<bool>`, **default off**, each gated by
    `mail_client` + a resolvable loopback mail-role model. Prerequisite for
    #204–#208.

204. **Summarize incoming mail.** `mail_summarize(message_id)` → fetch body text
    (reuse `mail_body`'s decode/sanitize path), truncate, prompt for ≤N bullet
    points, return plain text. **Ephemeral** — never persisted (decrypted
    plaintext to disk is forbidden); held in frontend state per open. UI: a
    "Summarize (local)" control in `MailMessageView` (on-demand;
    auto-on-open a later sub-option). Toggle `mail_ai_summarize`.

205. **Auto-classify → Important / Urgent.** In `sync_inner`, **new inbox
    messages only, after the keyword-filter pass** (mail.rs:1756), reading
    **subject + sender + preview snippet only** (never a body download). Must
    **not masquerade as a keyword filter** (schema doc mandate): a mail-DB bump
    adds `priority_source` (`user|filter|model`) + `priority_reason`, **sealed**,
    so the UI can say *"marked Urgent by the local model: '…'"*. A model failure
    **never fails a sync** (skip/cap/timeout). `mail_ai_classify_apply(dry_run…)`
    is the manual "what would this catch" counterpart, mirroring
    `mail_filters_apply` but with its own source-labelled report. Toggle
    `mail_ai_autoclassify` (read in the backend sync).

206. **Formalize a reply from notes.** `mail_formalize_reply(notes,
    message_id?, account_id, tone?)` → optional original body as context + rough
    notes → a formal reply body. **Never sends** — only fills the composer's
    `body_text` for explicit review/send. UI: a notes textarea + "Draft from
    notes" button in `MailComposeDialog`. Toggle `mail_ai_formalize`.

207. **Calendar entry from email.** `mail_extract_event(message_id)` → JSON
    `{ title, start, end?, all_day, location?, confidence }`, prompt anchored on
    the message `Date` **and** today so relative phrasing resolves; parsed
    defensively (low confidence / unparseable → no event). **Review before
    create is the default**: pre-fill the existing `EventDialog` for one
    confirming click. **Full automation is opt-in** (`mail_ai_auto_create`,
    default off) — a high-confidence event created without the dialog, tagged
    with mail provenance and deletable. Writing `calendar.json` is local/offline.
    Toggle `mail_ai_calendar`.

208. **To-do card from email.** `mail_extract_task(message_id)` → JSON
    `{ title, due?, priority? }`, same anchoring/defensive parse. **Reuses
    `taskFromMail`** so an AI card is the same kind of card as a hand-made one
    (board's first column, carries the mail link). Same **review-by-default /
    `mail_ai_auto_create` opt-in** posture as #207. Toggle `mail_ai_todo`.

**Verification:** `cargo test` (pure helpers — prompt builders, JSON extractors,
date anchoring, classify/event/task parsers, provenance round-trip,
loopback-refusal), `npm test`, `npm run lint`, clippy, `privacy-check.sh`. **No
live run** (Claude cannot launch Tabtivity); every feature stays `untested` until
the user runs it, and each new surface carries an `UntestedTag`.

**Live QA (#203–#208)** — needs a loopback Ollama with a completion model tagged
🧠 Mail, `mail_ai_allow` on, and the per-account toggles on.
- [ ] 🖐️ #203 — with Ollama pointed at a non-loopback host, every AI action
  refuses with the loopback reason; an embedding-only model says to load a
  completion model; Ollama stopped → "not running", not an error dump.
  - [ ] ✅ Works on Linux (X11)
  - [ ] ❌ Doesn't work on Linux (X11)
  - [ ] ✅ Works on Linux (Wayland)
  - [ ] ❌ Doesn't work on Linux (Wayland)
  - [ ] ✅ Works on Windows
  - [ ] ❌ Doesn't work on Windows
  - [ ] ✅ Works on macOS
  - [ ] ❌ Doesn't work on macOS
- [ ] 🖐️ #204 — *Summarize (local)* on an open message yields bullets; reopening
  the message does not show a stored summary.
  - [ ] ✅ Works on Linux (X11)
  - [ ] ❌ Doesn't work on Linux (X11)
  - [ ] ✅ Works on Linux (Wayland)
  - [ ] ❌ Doesn't work on Linux (Wayland)
  - [ ] ✅ Works on Windows
  - [ ] ❌ Doesn't work on Windows
  - [ ] ✅ Works on macOS
  - [ ] ❌ Doesn't work on macOS
- [ ] 🖐️ #205 — a sync with new inbox mail marks some Important/Urgent and the UI
  says "marked by the local model: '…'"; Ollama stopped → the sync still
  succeeds; the dry-run apply lists matches without changing anything.
  - [ ] ✅ Works on Linux (X11)
  - [ ] ❌ Doesn't work on Linux (X11)
  - [ ] ✅ Works on Linux (Wayland)
  - [ ] ❌ Doesn't work on Linux (Wayland)
  - [ ] ✅ Works on Windows
  - [ ] ❌ Doesn't work on Windows
  - [ ] ✅ Works on macOS
  - [ ] ❌ Doesn't work on macOS
- [ ] 🖐️ #206 — in the composer, notes + *Draft from notes* fills the body and
  nothing is sent.
  - [ ] ✅ Works on Linux (X11)
  - [ ] ❌ Doesn't work on Linux (X11)
  - [ ] ✅ Works on Linux (Wayland)
  - [ ] ❌ Doesn't work on Linux (Wayland)
  - [ ] ✅ Works on Windows
  - [ ] ❌ Doesn't work on Windows
  - [ ] ✅ Works on macOS
  - [ ] ❌ Doesn't work on macOS
- [ ] 🖐️ #207/#208 — a mail with "meeting tomorrow at 3" pre-fills the event
  dialog with the right date; to-do extraction makes a first-column card with the
  mail link; with `auto_create` on, both are created without a dialog.
  - [ ] ✅ Works on Linux (X11)
  - [ ] ❌ Doesn't work on Linux (X11)
  - [ ] ✅ Works on Linux (Wayland)
  - [ ] ❌ Doesn't work on Linux (Wayland)
  - [ ] ✅ Works on Windows
  - [ ] ❌ Doesn't work on Windows
  - [ ] ✅ Works on macOS
  - [ ] ❌ Doesn't work on macOS

**Live QA — agent attachments (#859b)** —
needs `root_mcp_mail` on, a mail account, and Settings → Agent fence → *Root
agent reads projects* on before the root tab is opened.
- [ ] 🖐️ #859b — in a root tab ask "write a mail to bob@example.com, attach
  `<project>/<a pdf>`": the draft under *Drafted by agents* says "1 attached ·
  suggests 1 recipients"; the composer shows the chip as `Project/path` with the
  *from agent* mark, Preview shows the file, To stays empty until the
  *Agent suggests* pill's Add; Send sends exactly that file. With the switch off
  (new root tab) the agent is told to switch it on; a `.env` or a symlink is
  refused by name.
  - [ ] ✅ Works on Linux (X11)
  - [ ] ❌ Doesn't work on Linux (X11)
  - [ ] ✅ Works on Linux (Wayland)
  - [ ] ❌ Doesn't work on Linux (Wayland)
  - [ ] ✅ Works on Windows
  - [ ] ❌ Doesn't work on Windows
  - [ ] ✅ Works on macOS
  - [ ] ❌ Doesn't work on macOS

# Mail client — first live QA against Gmail

The mail client is code-complete and has **never touched a real server**. This is
the ordered plan for the first live session. It extends
`docs/mail_client_plan_b.md` §7.9 with the setup, the Gmail specifics, and the
`Authentication-Results` feature added after that section was written.

Work top to bottom. Phases 0–5 are read-only; every write is in Phase 6, last and
optional. Each step says **what should happen** and **what it means if it
doesn't**, so a surprise is reportable rather than just confusing.

---

## Phase 0 — before you start

1. **Rebuild.** The last change touched `src-tauri/`, so hot-reload will not pick
   it up. Restart your instance from the rebuilt binary.
2. **Check the flag is on.** The client sits behind the `mail_client`
   experimental flag: off in a release build unless debug mode is on. If no Mail
   tab type is offered, that is the flag, not a bug.
3. **Get an app password.** `myaccount.google.com/apppasswords` — needs 2-Step
   Verification enabled. Your normal password will not work; Google retired basic
   auth. Make one *for this test* so you can revoke it in Phase 7.
4. **Take a baseline.** In Gmail on the web, note your **unread count** and open
   one message you will later open in Tabtivity, leaving it **unread**. Phase 2
   checks both are untouched.

Use a secondary account if you have one. Not because reading is risky — it is
demonstrably not (Phase 2) — but because the local copy is unencrypted on disk
and readable by any agent you run.

---

## Phase 1 — account setup

5. Open mail — the header's **✉** button (there is no mail tab; the overlay is
   the whole client) → add an account → pick the **gmail.com** preset. It should
   fill `imap.gmail.com:993` and `smtp.gmail.com:465`, both **TLS** (not
   STARTTLS). *If it fills 587/STARTTLS anywhere, stop and report* — the engine
   speaks implicit TLS only and will refuse the connection.
6. Enter your address and the app password. **Leave "Save password" off** for now
   — it should default to off. *A checkbox that starts on is a bug.*
7. Click **Test connection** before saving.
   - **Expect:** both IMAP and SMTP reported OK, within a few seconds.
   - *Hangs with no result:* report it — every network op is supposed to be
     bounded by a timeout, and a hang means one isn't.
   - *"unencrypted or STARTTLS port" error:* the ports got changed somewhere.
8. **Deliberately fail once.** Retype the password wrong and Test again.
   - **Expect:** a clear authentication failure, one attempt, no retry loop, no
     freeze. Then fix it.

---

## Phase 2 — first sync, and proving it changed nothing

9. Save the account. **Nothing should reach the network yet** — the tab reads the
   local index only. *If it starts syncing on save, report it*: the "never
   connects on its own" rule is deliberate.
10. Click **Check mail**.
    - **Expect:** a folder list appears. Gmail is label-based, so expect `INBOX`
      plus `[Gmail]/All Mail`, `[Gmail]/Sent Mail`, `[Gmail]/Drafts`,
      `[Gmail]/Spam`, `[Gmail]/Trash`, and possibly `Starred`/`Important`. This
      folder model is completely untested — **note anything odd about the names,
      the nesting, or the counts.**
    - **Non-ASCII folder names** (a localized account: `Entwürfe`, `Gesendet`,
      `Papierkorb`, Cyrillic, CJK) must read correctly. Found and fixed in the
      first live run: IMAP encodes mailbox names in *modified UTF-7*, so
      `Entwürfe` arrives on the wire as `Entw&APw-rfe` and was being displayed
      that way. Only the **display name** is decoded — the path stays wire-form,
      or `SELECT` on any folder with an umlaut in it fails. Seeing the fix needs
      a rebuild plus one *Check mail* to refresh the stored names.
    - Up to 200 headers per folder. `[Gmail]/All Mail` holds everything, so its
      200 will span labels.
11. **Watch the window while it syncs.** Any freeze of the whole UI — not just
    the mail pane — is the single most important thing to report. That class of
    bug (a synchronous command on the main thread) has bitten this project twice.
12. Open several messages, including the one you left unread in Phase 0.
13. **Now go back to Gmail on the web and reload.**
    - **Expect: your unread count is unchanged, and the message you opened in
      Tabtivity is still unread.** Reads use `BODY.PEEK`, never `BODY`, so nothing
      you look at should be marked read on the server.
    - *If anything got marked read, stop testing and report immediately.* That
      would mean the peek discipline broke somewhere.

---

## Phase 3 — Authentication-Results (the new feature)

The panel sits under the Date line in the message view.

14. **Before configuring anything**, open a message.
    - **Expect:** "Sender checks not shown — no trusted server name set for this
      account", plus the explanation. **No SPF/DKIM/DMARC verdict anywhere.**
    - *If you see verdicts before setting the id, that is the one failure this
      whole feature is designed to prevent.* Report it.
15. **Find your real `authserv-id`.** In Gmail on the web, open any message →
    ⋮ → **Show original** → read the top `Authentication-Results:` line. The
    first token is the id. For Gmail it is expected to be `mx.google.com`, but
    take it from the message, not from this document.
16. Put it in the account settings → save. **Re-open a message** (no re-sync
    needed — the trust state is recomputed on every read).
    - **Expect:** verdicts appear immediately for mail already synced. *If you
      have to re-sync, the on-every-read design isn't working as intended.*
    - **Gotcha:** messages synced *before* the rebuild have no stored header data
      and will show nothing. Click **Check mail** once to backfill them.
17. **The three real-world cases.** Find one of each:
    - **A Google security alert** → expect DMARC/SPF/DKIM all green, each
      reading "for `<their domain>`".
    - **A commercial newsletter or booking confirmation** → expect a **green
      summary over some amber chips**, plus the sentence explaining why. This is
      the normal shape of mail sent through a service: the envelope sender is
      the ESP's bounce domain, so SPF passes unaligned, and there are often two
      DKIM signatures (the brand's, aligned; the ESP's, not). DMARC passing on
      the aligned one is the authoritative answer, so the *summary* is green and
      the amber chips are its workings. Found in the first live run reading
      "Passed only in part", which was true of the clauses and wrong about the
      message.
    - **A forwarded message** → SPF often *fails* outright (forwarding breaks
      it) while DMARC still passes on DKIM. Also expected to summarize green.
    - The case that must **not** go green: a `pass` whose only aligned signal is
      missing — an unaligned pass with no DMARC answer behind it stays amber and
      summarizes as "passed only in part".
    - **A message in `[Gmail]/Sent Mail`** → your own mail was never received by
      Google's inbound MX, so it likely carries no header at all. **Expect the
      panel to be absent entirely** — not a failure, not a warning. Absence is
      not failure.
18. **Simulate a forgery, for free.** Change the trusted id to something wrong —
    `mx.not-my-provider.example` — and re-open a message.
    - **Expect:** every verdict disappears and a warning names the server that
      actually wrote them ("These results were written by mx.google.com, not by
      your mail server — ignore them").
    - This is exactly what a phisher's forged header would look like. Then set it
      back.
19. **Clear the field entirely** → re-open a message → back to the "not shown"
    state, immediately.

---

## Phase 4 — body rendering and links

20. Open a **real HTML newsletter**.
    - **Expect:** legible layout, and a banner saying *n* remote images were
      blocked. There is deliberately **no button to load them** — that is not a
      missing feature. (Plan B §7.9 still lists a "Load images once" test; that
      line is stale, the control was deliberately not built.)
    - **A blank or truncated body is the known bug to look for.** An unclosed
      `<math><mtext>` / `<svg><title>` in a message deletes everything after it,
      silently. If a newsletter renders empty or stops mid-message, that is
      probably it — **note the sender so the message can be turned into a
      fixture.**
21. *If you ever see the red "this message could not be shown safely" card*, that
    is the frontend tripwire firing, meaning the backend sanitizer let something
    through. **Report it with the sender** — it should never fire in practice.
22. Open a message with many links → the **Links panel**.
    - **Expect:** it opens without jank on WebKitGTK; the body's links are not
      clickable in place; the panel auto-expands if any link is suspicious.
23. Click a link → the confirm dialog.
    - **Expect:** the host called out separately, the full URL shown in monospace
      and **never** truncated with an ellipsis, and only then an Open button.
      Non-http(s) schemes get Copy only.

---

## Phase 5 — attachments

24. Open a message with an attachment. **Preview** it in-pane (images and text
    should render; anything else says so rather than offering a way out).
25. **Save** one.
    - **Expect:** exactly one OS dialog, one file, saved where you chose.
    - There is deliberately no "open with the system app" and no "save all".
26. If you can, mail yourself something with a deliberately odd filename
    (spaces, unicode, a double extension like `notes.pdf.exe`).
    - **Expect:** the name is shown sanitized, and a double extension or a
      type/bytes mismatch shows a persistent warning strip.

---

## Phase 6 — writes (optional, do last)

Everything up to here was read-only. These three actions are the entire write
surface. There is no `EXPUNGE` anywhere in the code, so nothing can be destroyed
outright — but on Gmail a "move" is a label change, so pick a message you don't
care about.

27. **Toggle a flag** — mark one message read, or star it. Verify it in Gmail web.
    **Avoid the Deleted flag**; Gmail treats `\Deleted` unlike a normal IMAP
    server and it is untested here.
28. **Move** one throwaway message to another label. Verify in Gmail web, and
    verify you can move it back.
29. **Send** a message to yourself.
    - **Expect:** it arrives; the composer is plain-text only; attaching raises
      the OS picker from the backend.
    - Check the received copy's headers: **Bcc must not appear**, and the
      Subject must not have been able to inject extra headers.

---

## Phase 7 — cleanup

30. Delete the account in Tabtivity. **Expect** its local mail to go with it — the
    saved password does not, by design (it is keyed by server target and may be
    shared; "Forget saved password" is its own verb).
31. Check `~/.local/share/tabtivity/mail/` — `mail.db` and `blobs/` should be
    `0600`, the directory `0700`.
32. **Revoke the app password** at `myaccount.google.com/apppasswords`.

---

## What to report back

For anything unexpected: **what you did, what you saw, and the sender/subject**
if a specific message triggered it. The most valuable outcomes, in order:

1. Anything that got **marked read or modified** on the server that you didn't do.
2. Any **whole-window freeze**.
3. A **blank or truncated body** (the known foreign-content bug, with a sender so
   it can become a fixture).
4. The **unsafe-body card** ever appearing.
5. Verdicts shown **before** a trusted id was configured.
6. Anything about **Gmail's folder model** that looks wrong — that part has no
   test coverage at all.

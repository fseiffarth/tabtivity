# Mail encryption — why it is shaped this way

Two features that share a prefix and almost nothing else.

- **`services/mail_crypt.rs`** encrypts the **local store**. Applies to every
  account, independent of what any correspondent supports.
- **`services/mail_crypto.rs`** + **`services/mail_pgp.rs`** handle what the
  **sender** did to a message before it left their machine.

They are sequenced, not merely ordered: the end-to-end track caches nothing and
holds private keys, and putting either into a plaintext store would make the
store key cryptographically equivalent to the mail key. `PgpKeyring::open` takes
`MailKeys` and there is no constructor that does not — the coupling is enforced
by the type, not by a convention.

---

## What at-rest encryption is actually for

**Not** the stolen laptop. Full-disk encryption already answers that for most
people, and the UI says so rather than implying more. What this adds is
**backups, copies, cloud-synced folders and multi-user machines** — places FDE
is not in play — plus the one thing FDE does not cover at all: someone with
*write* access to the files relocating a ciphertext.

It adds **nothing** against a live process, or anyone who can run code as the
user. That is stated in the dialog, because a security feature that oversells
itself buys behaviour changes it did not earn.

## Three decisions that carry the at-rest design

**Values are sealed, not the file.** SQLCipher was ruled out by the no-OpenSSL
invariant, but it would be the wrong shape anyway. Because every *value* is
already an envelope by the time SQLite sees it, the WAL and the freelist can
only ever contain ciphertext — there is no window in which SQLite writes
plaintext. The single exception is a store that already existed in cleartext,
which is why that migration ends in `VACUUM INTO` a **new file**: sealing values
with `UPDATE` leaves every old subject line in the freelist, readable with a hex
editor.

**XChaCha20-Poly1305, nonce drawn at random.** The 192-bit nonce is the whole
reason. AES-GCM's 96-bit nonce is too small to draw randomly, so it needs a
counter — a counter that must survive both a crash and a restore-from-backup,
and that is how nonce reuse actually happens in the field. A restored backup here
re-derives nothing and reuses nothing.

**Every ciphertext is bound to its row by AAD.** This is the part at-rest
encryption is famous for leaving open. Without it, an attacker with disk write
access copies message A's sealed body onto message B's row and the client renders
it as B — no key broken; the tag is simply valid for the wrong row. It costs one
string concatenation, and
`mail_crypt::tests::a_sealed_value_cannot_be_relocated_to_another_row` plus the
store-level twin are what keep it true.

## Consequences you will hit while working on it

**A sealed column cannot carry a `UNIQUE`.** Randomized AEAD means two seals of
one folder path differ, so `UNIQUE (account_id, path)` would stop deduplicating
and every sync would insert the folder again. Schema v2 moves the constraint onto
`folders.path_key`, a keyed digest (`mail_crypt::name_digest`) sitting in
cleartext beside the sealed value. It leaks equality and only equality — exactly
what declaring the constraint already asserts.

**Blob ids are keyed, not bare digests.** `SHA-256(plaintext)` did two bad things
at once: it was a confirmation oracle (hash a file you suspect somebody received,
look for its name in a directory listing), and it could not have survived
sealing, because a digest of the *ciphertext* is never stable. `HMAC-SHA256
(k_addr, plaintext)` keeps dedupe and is meaningless without the key. Still 64
hex characters, so `get_blob`'s validation is untouched.

**Search cannot use `LIKE`.** There is nothing to match against but ciphertext.
Blind indexes were rejected outright — a deterministic per-token fingerprint
leaks word frequency and answers "does this mailbox contain word X", which is
most of what the encryption was for. What is left is bounded decrypt-on-scan
(50 000 rows), and the page reports `scanned` when it stopped so the UI can say
*"searched the most recent N messages"*. A truncated answer that looks complete
is the one thing a search must never produce.

**An unreachable key degrades; it does not lock the mailbox.** A locked Secret
Service collection reads identically to "nothing saved" and can block a read
forever — the failure class `remote_credentials::read_timed` already exists for,
and which once left this app's connection lamps permanently amber. Here it opens
an *ephemeral* store: `:memory:` index, blobs in a temp directory sealed under a
key that dies with the process. Mail syncs and reads; nothing persists. It looks
exactly like a working mailbox until the next launch, which is why
`MailEncryptionState` reports it and the pane shows an interrupting strip.

**The sealed *files* must resolve the key themselves.** `accounts.json.enc` and
`filters.json.enc` sit beside the database under the same master key, and they
are read by commands that never open the database — `mail_accounts_list` is the
first mail command a launch runs. That is where the session-key handle bit back:
it was published only by `store_of`, so on a cold process the account read found
no key, skipped the sealed file, looked for the plaintext one the migration had
deleted, and answered **an empty list**. The user's configured account appeared
to have vanished; nothing had asked for its key yet. The write half was the worse
half — re-adding the account then wrote a *cleartext* `accounts.json` beside the
sealed file that every later read prefers, so the fix would vanish too and leave
an unencrypted copy of the account list on disk.

Two rules close it, and both belong to the *file* layer rather than to any one
command. `file_keys()` attempts a silent unlock itself (**once** per process — a
locked keyring costs a bounded 4 s read, and these commands run on a timer) and
degrades to `None` like everything else here. And a plaintext write is
**refused** whenever a sealed twin exists without a key (`sealed_write_refusal`),
because the alternative is a save that reports success and is then permanently
ignored. The twin's path is derived from the file's own path, so a read against
any directory is self-contained — it used to take the plaintext name from its
argument and the sealed one from the global state dir, which meant a call against
a temp directory quietly read the real mailbox's account list.

**A server re-keys the whole store when a device is revoked** (hosted plan
§6.8, decision 2026-10-03; the desktop never does). Re-wrapping the master key
— the cheap trick the key file's indirection exists for — is not enough there:
a revoked device with old copies of `key.json` and `wraps.json` would still
open everything sealed later. So the rotation writes a *fresh* master and keeps
the old ones in `key.json`'s `previous` list; reads try the current master,
then each previous one (`MailKeys::open_any`); every write uses the current
one, read under the store's connection lock, which a key switch takes too; and
`MailStore::rekey_step` moves sealed values, keyed blob names and staged files
batch by batch, one transaction each with its progress marker in `meta`. The
old master leaves `key.json` only after a full pass found nothing left under
it (`retire_previous`). Because every step re-checks each value under the
current key, a crash anywhere costs time, never data; why and the lock order:
[`server_gateway.md`](server_gateway.md) § Secrets.

**Owner-only is set per folder, not per file.** A sync writes one blob per
message. On Unix each blob and staged outbox file is created with mode `0600`
(`write_store_file`), so it is never world-readable, not even between the write
and a chmod. On Windows, restricting each file meant two `icacls` spawns per
message. So the store's folder gets an owner-only ACL once, at open, with an
inheritable `(OI)(CI)` grant (`mail_crypt::harden_store_dir` →
`private_file::restrict_dir_to_owner_inheritable`). That call is skipped when the
folder already has this ACL, because changing a folder's ACL walks everything
under it. The files in `blobs/` and `outbox/` inherit the ACL and need no
`icacls` run of their own. `mail.db` and `key.json` are still restricted one by
one, because they are written rarely.

**What stays readable on disk**, by design: message counts, folder structure,
arrival dates, sizes, read/starred/priority flags — they are what paging,
ordering and unread counts run on. One item is sharper than "folder structure"
sounds and is pinned by a test rather than left implicit: a folder id is an
**unkeyed** `sha256(path)[..8]`, so a wordlist recovers which folders exist.
Keying it would mean re-deriving every message id, which is also every AAD row
key — a stated cost, not an oversight.

---

## The end-to-end half

**One ordering is non-negotiable: `decrypt → parse → sanitize → render`.**
Decryption confers no trust whatsoever. A decrypted body is if anything *more*
attacker-controlled than a plain one, because it arrived wearing a padlock and
may have been encrypted *to* the victim by the attacker — so it goes through the
same structural caps, the same `sanitize_message_html`, and the same `sandbox=""`
frame. `tests/mail_hostile_crypto.rs` is the fixture that proves it.

**Decrypted plaintext is never written to disk.** Not to `bodies_cache`, not to a
blob, not to `preview`. If it were, the store key would become cryptographically
equivalent to the PGP private key and the end-to-end guarantee would collapse
into the at-rest one. An encrypted message is therefore re-fetched and
re-decrypted on every open.

**Curve25519 only, and that is a security decision.** `pgp` depends on `rsa`
unconditionally; RUSTSEC-2023-0071 (Marvin timing oracle) is unpatched, and no
feature gates it out, so the `cargo audit` finding is permanent. But the oracle
is in RSA PKCS#1 v1.5 **decryption**, and nobody can encrypt to a key we do not
have — so generating Curve25519 keys means the vulnerable code is compiled in and
never run for our mail. RSA stays *importable*: a correspondent's key is only ever
used to verify.

**Verified vs merely known.** OpenPGP has no certificate authority. There is no
`webpki` to lean on and nothing asserting that a key belongs to a person — trust
comes from the user having compared a fingerprint out of band, and from nothing
else. So an imported key is `Known`, only an explicit "I checked this" promotes
it, and **only `Verified` *and* address-aligned earns positive chrome**. Drop the
middle clause and a padlock goes to whoever last emailed you a key; drop the last
and it goes to anyone with *a* verified key signing as anyone they like.

**Headers are outside the signature, in both formats.** A signed message does not
authenticate its own `From`, `Subject` or `Date`. The backend emits a
`headers-not-signed` note for every signed message precisely so the panel cannot
forget to say it.

**`signed_part_bytes` is the most dangerous function in the feature**, because
its failure is silent *and positive*: a verifier fed the wrong bytes reports a
pass over something the sender never signed. It slices the raw message (RFC 3156
signs the part **including its MIME headers**, in its **transfer-encoded** form)
and drops the CRLF that introduces the closing boundary.
`a_wrapped_signed_message_verifies_after_a_round_trip_through_mime` is the test
that would catch a mistake there — every other signature test feeds the verifier
the same buffer the signer saw.

**Sign inside, then encrypt.** The other ordering lets anyone strip the signature
and re-sign the same ciphertext as their own, so it would attest to who
*forwarded* the message rather than who wrote it.

**A sealed send never falls back to plaintext.** A missing recipient key is an
error naming the address. A silent downgrade is the single worst thing an
encryption feature can do, because it looks exactly like success — which is also
why the composer asks which recipients lack a key *while the message is being
written* rather than on Send.

**IMAP `APPEND` lands last, deliberately.** Before it there was no Sent copy at
all, which was accidentally the most private behaviour available; adding it
*without* encrypt-to-self is precisely how a plaintext Sent copy of an encrypted
message ships. It appends the bytes that were actually sent, and a failed APPEND
never reports a failed send — the message is already delivered, and saying
otherwise is how one gets sent twice.

**Inline (pre-MIME) signatures are reported, not checked.** The cleartext-
signature framework has its own dash-escaping and canonicalization rules, and a
verifier that got them subtly wrong would report passes over text nobody signed.
Named honestly beats checked badly.

**S/MIME is detected and deferred.** No certificate is issued to the user, so the
track has no credential to load. Detection still ships, because a
recognized-but-unsupported format renders a banner while an unrecognized one
renders its ASN.1 blob as though it were the mail. The `MailCrypto` trait exists
so un-deferring it is an added implementor, not a fork of the message pipeline —
and the plan's finding that `rustls-webpki` (already in the bundle) is a
perfectly good email-certificate validator remains correct and free.

---

## What the agent path can and cannot read

The root MCP's mail tools (`services::root_mcp_mail`, `docs/context/root_console.md`)
reach mail through `commands::mail::AgentMail`, which **never opens or unlocks
the store**: a store not opened this run, or opened as the memory-only
stand-in, answers "mail is locked" and nothing prompts. `mail_read` shares
`body_inner` with `mail_body` — same cache, same `BODY.PEEK[]`, same
`decrypt → parse → sanitize` order — so the two cannot drift.

**End-to-end encrypted mail is opaque to agents.** `mail_read` returns headers
and the crypto verdict and drops the body, link texts and attachment names of
any message with `crypto.encrypted`. The per-account `agent_access` switch
consents to ordinary mail reaching a cloud model; the sender of an encrypted
message chose its readers, and an agent's provider is not one of them. There is
deliberately no second switch. Signed-only mail is readable, verdict attached.
The local assistant's invariant (`mail_ai` refuses any non-loopback model) is
untouched — the agent tools never call it.

---

## The one thing that has not happened

**None of this has run against a real server or a real correspondent.** The mail
client underneath it had no live QA either. Interop with Thunderbird and Outlook,
unlock latency, keychain-locked behaviour and the migration of a store that
actually holds mail are all manual and all outstanding.

//! The local mail index: SQLite for folders/headers/flags/attachment metadata
//! and drafts, plus a content-addressed blob directory for payloads.
//!
//! `AppHandle`-free and factored on a `&Path`, exactly like
//! `commands::calendar`'s store — which is why the tests below can drive a
//! tempdir and why the whole thing is unit-testable without a mail server.
//!
//! Two decisions worth stating, because they are what the file boundary rests
//! on:
//!
//! - **Blob names are content-addressed and opaque** (`blobs/<sha256-hex>`, no
//!   extension). The sender-supplied filename lives only as a column here and
//!   as a label in the UI, so a filename attack has no filesystem to attack —
//!   the name never reaches a syscall.
//! - **The store never takes a path from the frontend.** Everything resolves
//!   under the directory the caller opened it on, which `commands::mail`
//!   resolves as `storage::state_dir().join("mail")` and nowhere else.
//!
//! # Encryption at rest (`docs/mail_encryption_plan.md` Phase 2)
//!
//! Optional, and opened through [`MailStore::open_with_keys`]. When keys are
//! present every *sensitive value* is a [`mail_crypt`] envelope; when they are
//! absent this file behaves exactly as it did before, which is what keeps the
//! unencrypted path (and every test below) honest rather than a second
//! implementation.
//!
//! The earlier version of this comment argued encryption was not worth it,
//! because FileVault/BitLocker/LUKS answers the stolen-laptop case and a locked
//! keychain would make the mailbox unreadable. The first half is still true and
//! is stated plainly in the UI — the marginal value here is **backups, copies,
//! sync services and multi-user machines**, where FDE is not in play. The second
//! half was the real objection and it is answered structurally: an unreachable
//! key is a *degrade*, not a refusal. `commands::mail` opens an ephemeral store
//! ([`MailStore::open_ephemeral`]) whose key dies with the process — sync works,
//! the mailbox reads, nothing persists — instead of showing an empty window.
//!
//! Three properties are worth knowing before changing anything here:
//!
//! - **Values are sealed, not the file.** So the WAL and the freelist can only
//!   ever hold ciphertext; there is no window where SQLite writes plaintext. The
//!   one exception is a store that already existed in cleartext, which is why
//!   [`MailStore::seal_existing`] ends in `VACUUM INTO` a *new* file rather than
//!   an in-place `UPDATE`.
//! - **Structural columns stay cleartext** (`id`, `account_id`, `folder_id`,
//!   `uid`, `date`, `seen`, `flagged`, `size`, `priority`, blob references, every
//!   index), because they are what paging, ordering and unread counts run on.
//!   The metadata that therefore remains readable on disk — message counts,
//!   folder structure, arrival dates, sizes, read/starred flags — is stated in
//!   the UI rather than buried here. Anyone who needs *that* hidden needs FDE,
//!   which hides filenames too. One item deserves naming precisely, because it
//!   is sharper than "folder structure" sounds: a folder id is an **unkeyed**
//!   `sha256(path)[..8]` (`commands::mail::folder_id_for`), so a wordlist
//!   recovers which folders exist. Keying it would mean re-deriving every
//!   message id — which is also every AAD row key — so it is a stated cost
//!   rather than an oversight; `tests::encrypted` pins it.
//! - **A sealed column cannot carry a `UNIQUE`.** Randomized AEAD means two
//!   seals of one folder path differ, so the constraint would stop deduplicating
//!   and every sync would insert the folder again. `folders.path_key` and
//!   `mail_remote_allow.addr_key` are keyed digests (`mail_crypt::name_digest`)
//!   that carry the constraint in cleartext beside the sealed value. They leak
//!   equality and only equality — which is precisely what declaring the
//!   constraint already asserts. Because they are derived from the key rather
//!   than from the value alone, they have to be *maintained*: sealing a store
//!   that ran plain leaves them holding the cleartext, which is both a leak and
//!   a constraint that has stopped matching, so every keyed open runs
//!   [`MailStore::rekey_digest_columns`].

use std::path::{Path, PathBuf};
use app_core::sync::LockExt;
use std::sync::{Arc, Mutex};

use rusqlite::types::Value as SqlValue;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row, ToSql};

use crate::schema::mail::{
    MailAddress, MailAttachmentMeta, MailDraft, MailFlag, MailFolder, MailFolderKind, MailHeader,
    MailHeaderPage, MailPriority, MailPriorityCounts, MailPrioritySource, MailSort,
    NewStagedFile, StagedAttachment,
};
use crate::services::mail_crypt::{self, harden, MailKeys};

/// One staged file of a send: its row and the decrypted outbox copy.
pub type OutgoingFile = (StagedAttachment, Vec<u8>);

/// Forward-only schema version, recorded in `meta`.
///
/// **2** added the keyed `UNIQUE` stand-ins (`folders.path_key`,
/// `mail_remote_allow.addr_key`). It is a shape change rather than an additive
/// column, so it rebuilds those two tables — see [`MailStore::migrate`].
const SCHEMA_VERSION: i64 = 2;

/// How many rows a search over an **encrypted** store will open before it stops
/// and says so.
///
/// `LIKE` cannot run over ciphertext, and a blind index — a deterministic
/// per-token fingerprint — was rejected outright: it leaks word frequency and
/// answers "does this mailbox contain word X", which is most of what the
/// encryption was for. What is left is decrypt-on-scan, which is fast
/// (XChaCha20 runs on the order of a GB/s, so this bound is milliseconds) but
/// not free, so it is bounded. When the bound is hit the page reports
/// `scanned`, and the UI says *"searched the most recent N messages"* — the one
/// thing a search must never do is silently truncate and look complete.
const MAX_SEARCH_SCAN: usize = 50_000;

/// A folder search uses the same fields as IMAP `SUBJECT`/`FROM`; the existing
/// local list and priority searches keep their broader preview matching.
#[derive(Clone, Copy, PartialEq, Eq)]
enum SearchFields {
    SubjectSenderPreview,
    SubjectSender,
}

/// The `meta` key set once the store's existing plaintext has been sealed.
const META_ENCRYPTED: &str = "encrypted";

/// Every sealed column, by table: `(table, primary key, account column,
/// columns)`. The AAD's row key is the primary-key columns NUL-joined, which
/// is how the read and write paths build theirs. The one list both passes
/// over existing values walk — sealing a store that ran plain
/// ([`MailStore::seal_existing`]) and re-keying one ([`MailStore::rekey_step`])
/// — so a column added to one is added to both.
type SealedTable = (&'static str, &'static [&'static str], Option<&'static str>, &'static [&'static str]);
const SEALED_TABLES: &[SealedTable] = &[
    (
        "messages",
        &["id"],
        Some("account_id"),
        &[
            "subject",
            "from_json",
            "to_json",
            "cc_json",
            "preview",
            "malformed",
            "rfc_message_id",
            "authres_json",
            // A model's reason quotes the message, so it is sealed on write;
            // leaving it off this list left every reason written before
            // encryption was turned on in the clear, permanently.
            "priority_source",
            "priority_reason",
        ],
    ),
    ("bodies_cache", &["message_id"], None, &["html", "text", "links_json"]),
    ("attachments", &["message_id", "part_id"], None, &["filename", "mime", "mismatch"]),
    ("drafts", &["id"], Some("account_id"), &["json"]),
    ("staged", &["draft_id", "staged_id"], None, &["filename", "mime", "source"]),
    ("folders", &["id"], Some("account_id"), &["path", "name"]),
    ("mail_remote_allow", &["addr_key"], None, &["address"]),
];

/// The `meta` key of a re-key's progress marker ([`MailStore::rekey_step`]).
const META_REKEY: &str = "rekey_cursor";

/// Where a re-key stands, kept in `meta` and written in the same
/// transaction as the batch it describes, so a crash never leaves it ahead
/// of what is on disk. It is only a shortcut: every step re-checks each
/// value under the current key and skips what already opens there, so a
/// marker behind the truth costs time, never data.
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct RekeyCursor {
    /// [`MailKeys::fingerprint`] of the master this pass moves to; another
    /// one (a second revoke mid-way) starts the pass over.
    target: String,
    /// 0 the keyed digests, 1..=N the tables of [`SEALED_TABLES`], then the
    /// blob files, then the outbox.
    stage: usize,
    /// The last rowid done in the current table.
    after: i64,
    /// The last blob file name done.
    #[serde(default)]
    blob_after: String,
    /// Old blob files whose rows were pointed at their re-sealed copies in
    /// the transaction that saved this marker: deleted right after it, and
    /// again by the next step in case a crash came between.
    #[serde(default)]
    unlink: Vec<String>,
}

/// Rows read per re-key batch, and the sealed bytes after which a batch
/// stops early: what bounds how long one batch holds the store's lock.
const REKEY_ROWS: usize = 200;
const REKEY_BYTES: usize = 4 * 1024 * 1024;

/// What one [`MailStore::rekey_step`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RekeyStep {
    /// More to do; `seen` rows or files were looked at, `moved` re-sealed.
    More { seen: usize, moved: usize },
    /// Every value opens under the current master: the previous ones may be
    /// retired (`mail_crypt::retire_previous`).
    Done,
}

/// Where a re-key step can stop when the process dies (the tests' crash
/// points; blob files are the only work outside one transaction).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RekeyCrash {
    /// New blob files written, their references not yet committed.
    BlobsWritten,
    /// References committed, the old files not yet deleted.
    BlobsCommitted,
}

/// What a simulated crash returns.
pub const REKEY_CRASHED: &str = "crashed";

/// How many of the user's own replies one message lists. A thread answered more
/// often than this is read in the Sent folder, not in a strip above a body.
const MAX_REPLIES: usize = 20;

/// Bodies larger than this are content-addressed into `blobs/` instead of
/// living in the row.
pub const INLINE_BODY_LIMIT: usize = 256 * 1024;

pub struct MailStore {
    dir: PathBuf,
    conn: Mutex<Connection>,
    /// `None` means the store is unencrypted — every column holds the value the
    /// caller passed. Not a degraded mode: it is what an install that never
    /// turned encryption on looks like, and it is the path every test below
    /// exercises.
    ///
    /// Behind a lock of its own because a server's rotation swaps them while
    /// the store is open ([`MailStore::switch_keys`]). Held only for the
    /// moment it takes to clone the `Arc` (never while taking another lock);
    /// every write reads them **while holding `conn`**, and a switch takes
    /// `conn` too, so nothing is sealed under keys a switch has replaced.
    keys: Mutex<Option<Arc<MailKeys>>>,
    /// Set once a sealed store's migration is known complete. From then on a
    /// non-empty `TEXT` value in a sealed column is not "not migrated yet" but a
    /// value this store never wrote — plaintext planted by whoever could write
    /// `mail.db` — and reads as damaged instead of rendering unauthenticated.
    refuse_plaintext: bool,
    /// Held only by [`MailStore::open_ephemeral`], and only so it is deleted
    /// when the store is dropped.
    _scratch: Option<tempfile::TempDir>,
}

impl std::fmt::Debug for MailStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MailStore")
            .field("dir", &self.dir)
            .field("encrypted", &self.is_encrypted())
            .finish()
    }
}

impl MailStore {
    /// Open (creating if needed) an **unencrypted** store rooted at `dir`.
    pub fn open(dir: &Path) -> Result<Self, String> {
        Self::open_with_keys(dir, None)
    }

    /// Open the store rooted at `dir`, sealing every sensitive value under
    /// `keys` when they are given.
    ///
    /// Opening an existing cleartext store *with* keys performs the one-way
    /// migration in [`MailStore::seal_existing`], which is idempotent and
    /// therefore restartable: interrupting it half-way leaves a store where some
    /// values are sealed and some are not, and the next open finishes the job.
    pub fn open_with_keys(dir: &Path, keys: Option<Arc<MailKeys>>) -> Result<Self, String> {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("could not create the mail store: {e}"))?;
        mail_crypt::harden_store_dir(dir);
        let db = dir.join("mail.db");
        let conn = Connection::open(&db).map_err(|e| e.to_string())?;
        harden(&db, 0o600);
        configure(&conn);
        let encrypted = keys.is_some();
        let mut store = MailStore {
            dir: dir.to_path_buf(),
            conn: Mutex::new(conn),
            keys: Mutex::new(keys),
            refuse_plaintext: false,
            _scratch: None,
        };
        store.migrate()?;
        let was_marked = encrypted && store.marked_encrypted()?;
        let sealed = store.seal_existing()?;
        // Between the sealing pass and the vacuum, deliberately. The pass is
        // what strands a digest — it seals a value and leaves the key column
        // beside it untouched — and the vacuum is what stops the old cleartext
        // key from surviving in the freelist of the file that replaces it.
        // A `match`, not `?`: CodeQL carries a `?`'s value on into the
        // function's return, and this count then read as the store's key.
        #[allow(clippy::question_mark)]
        let rekeyed = match store.rekey_digest_columns() {
            Ok(count) => count > 0,
            Err(e) => return Err(e),
        };
        // A store that was never marked done also gets the vacuum when this
        // pass found nothing left to seal: that is the store whose previous
        // sealing pass completed and then died before its vacuum.
        if sealed || rekeyed || (encrypted && !was_marked) {
            store.vacuum_into_place()?;
        }
        if encrypted && !was_marked {
            store.mark_encrypted()?;
        }
        if encrypted {
            store.seal_late_columns()?;
            store.refuse_plaintext = true;
        }
        Ok(store)
    }

    /// Whether the database in `dir` says it was sealed, read without keys.
    ///
    /// A missing key file cannot be told apart from "never encrypted" by the
    /// key file alone, and treating a sealed store as new is what used to mint
    /// a fresh key over it — overwriting the keychain entry that was the only way
    /// back once `key.json` was restored from a backup.
    pub fn is_marked_encrypted(dir: &Path) -> bool {
        let db = dir.join("mail.db");
        if !db.exists() {
            return false;
        }
        let Ok(conn) = Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        else {
            return false;
        };
        conn.query_row(
            "SELECT value FROM meta WHERE key = ?1",
            params![META_ENCRYPTED],
            |r| r.get::<_, String>(0),
        )
        .map(|v| v == "1")
        .unwrap_or(false)
    }

    /// A store that lives and dies with the process.
    ///
    /// This is the **degrade path**, not a test fixture: it is what
    /// `commands::mail` opens when the store key cannot be reached — a locked
    /// Secret Service collection, most often, which reads identically to
    /// "nothing saved" and which this codebase has already been bitten by once.
    /// The alternative is a mailbox that will not open at all, and a mail client
    /// that refuses to show mail because a keyring prompt went unanswered is a
    /// worse outcome than one that forgets what it downloaded.
    ///
    /// The database is `:memory:`, so the index never touches disk. Blob
    /// payloads have to land *somewhere* — they can be tens of megabytes — so
    /// they go into a temp directory that is removed on drop, sealed under a
    /// **freshly generated master key that exists only in this process**. A
    /// crash that skips the cleanup therefore leaves bytes nobody can ever read,
    /// rather than plaintext attachments in `/tmp`.
    pub fn open_ephemeral() -> Result<Self, String> {
        let scratch = tempfile::tempdir().map_err(|e| e.to_string())?;
        mail_crypt::harden_store_dir(scratch.path());
        let keys = Arc::new(MailKeys::derive(mail_crypt::Key::random()?));
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        configure(&conn);
        let store = MailStore {
            dir: scratch.path().to_path_buf(),
            conn: Mutex::new(conn),
            keys: Mutex::new(Some(keys)),
            refuse_plaintext: false,
            _scratch: Some(scratch),
        };
        store.migrate()?;
        Ok(store)
    }

    /// Whether values in this store are sealed.
    pub fn is_encrypted(&self) -> bool {
        self.keys().is_some()
    }

    /// The keys right now. A writer calls this while holding `conn`.
    pub fn keys(&self) -> Option<Arc<MailKeys>> {
        self.keys.lock_ok().clone()
    }

    /// Whether this is the memory-only stand-in ([`MailStore::open_ephemeral`]).
    pub fn is_ephemeral(&self) -> bool {
        self._scratch.is_some()
    }

    /// Swap in the keys a server's rotation or a finished re-key left in
    /// `key.json` (hosted plan §6.8). Under `conn`: every write seals with
    /// keys read while holding it, so nothing written after this returns is
    /// sealed under the keys it replaced — which a re-key whose pass has
    /// already gone by would never move. Refused for a plain or a
    /// memory-only store: neither has a key file to follow.
    pub fn switch_keys(&self, keys: Arc<MailKeys>) -> Result<(), String> {
        let _conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let mut slot = self.keys.lock_ok();
        if slot.is_none() || self.is_ephemeral() {
            return Err("this mail store has no key file to follow".into());
        }
        *slot = Some(keys);
        Ok(())
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    // ── Sealing one value ───────────────────────────────────────────────────

    /// A value bound for a sealed column: a `BLOB` envelope when the store has
    /// keys, the plain `TEXT` otherwise.
    ///
    /// SQLite's dynamic typing is what makes this work without two schemas —
    /// `subject BLOB` and `subject TEXT` coexist in one column, which is also
    /// what makes [`MailStore::seal_existing`] restartable row by row.
    fn seal_text(
        &self,
        account_id: &str,
        table: &str,
        column: &str,
        row: &str,
        value: &str,
    ) -> SqlValue {
        match self.keys().as_deref() {
            Some(k) => SqlValue::Blob(mail_crypt::seal(
                &k.field,
                &mail_crypt::field_aad(account_id, table, column, row),
                value.as_bytes(),
            )),
            None => SqlValue::Text(value.to_string()),
        }
    }

    /// The nullable form. `NULL` stays `NULL` — sealing it would turn "no cached
    /// HTML part" into "an empty one", which the body cache distinguishes.
    fn seal_opt_text(
        &self,
        account_id: &str,
        table: &str,
        column: &str,
        row: &str,
        value: Option<&str>,
    ) -> SqlValue {
        match value {
            Some(v) => self.seal_text(account_id, table, column, row, v),
            None => SqlValue::Null,
        }
    }

    /// Read a possibly-sealed column.
    ///
    /// `None` means **the value was there and could not be opened** — a wrong
    /// key, or bytes that were altered on disk. It is deliberately distinct from
    /// `Some("")`: callers turn it into a per-message "damaged" marker rather
    /// than into empty content, because a subject line that silently reads as
    /// blank is an attacker's best case.
    fn open_text(
        &self,
        r: &Row<'_>,
        idx: usize,
        account_id: &str,
        table: &str,
        column: &str,
        row: &str,
    ) -> rusqlite::Result<Option<String>> {
        use rusqlite::types::ValueRef;
        Ok(match r.get_ref(idx)? {
            ValueRef::Null => Some(String::new()),
            // Empty (and the `'[]'`/`'{}'` JSON defaults) are column defaults,
            // not content. Anything else in plain text inside a completed sealed
            // store was not written by us.
            ValueRef::Text(t)
                if self.refuse_plaintext && !matches!(t, b"" | b"[]" | b"{}") =>
            {
                None
            }
            ValueRef::Text(t) => Some(String::from_utf8_lossy(t).into_owned()),
            // Every key a re-key still reads with (hosted plan §6.8): the
            // current master first, then the previous ones.
            ValueRef::Blob(b) => match self.keys().as_deref() {
                Some(k) => k
                    .open_any(
                        |k| &k.field,
                        &mail_crypt::field_aad(account_id, table, column, row),
                        b,
                    )
                    .ok()
                    .map(|(p, _)| String::from_utf8_lossy(&p).into_owned()),
                // A blob in a store with no keys is a store that *was* encrypted
                // and is now being opened without them. Nothing to do but say so.
                None => None,
            },
            _ if self.refuse_plaintext => None,
            other => Some(other.as_str().unwrap_or_default().to_string()),
        })
    }

    /// The nullable form: `Ok(None)` for a genuine SQL `NULL`, `Ok(Some(None))`
    /// for a value that would not open.
    #[allow(clippy::type_complexity)]
    fn open_opt_text(
        &self,
        r: &Row<'_>,
        idx: usize,
        account_id: &str,
        table: &str,
        column: &str,
        row: &str,
    ) -> rusqlite::Result<Option<Option<String>>> {
        use rusqlite::types::ValueRef;
        if matches!(r.get_ref(idx)?, ValueRef::Null) {
            return Ok(None);
        }
        Ok(Some(
            self.open_text(r, idx, account_id, table, column, row)?,
        ))
    }

    /// The cleartext stand-in a sealed column's `UNIQUE` moves onto.
    fn digest_of(&self, namespace: &str, value: &str) -> String {
        match self.keys().as_deref() {
            Some(k) => mail_crypt::name_digest(&k.name, namespace, value),
            // Unencrypted stores keep the readable value as its own key, so the
            // constraint means exactly what it always did and no migration is
            // needed to turn encryption on later.
            None => value.to_string(),
        }
    }

    pub fn blobs_dir(&self) -> PathBuf {
        self.dir.join("blobs")
    }

    /// The staging directory for one draft's picked attachments.
    pub fn outbox_dir(&self, draft_id: &str) -> PathBuf {
        self.dir.join("outbox").join(sanitize_id(draft_id))
    }

    fn migrate(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS folders (
                id         TEXT PRIMARY KEY,
                account_id TEXT NOT NULL,
                -- The cleartext key the UNIQUE moved onto when `path` became
                -- sealable. `mail_crypt::name_digest` in an encrypted store,
                -- the path itself in a plain one.
                path_key   TEXT NOT NULL,
                path       TEXT NOT NULL,
                name       TEXT NOT NULL,
                kind       TEXT NOT NULL,
                unread     INTEGER NOT NULL DEFAULT 0,
                total      INTEGER NOT NULL DEFAULT 0,
                -- What the server reported beyond the local index at the last
                -- sync; `refresh_counts` adds these to the local counts.
                unread_unindexed INTEGER NOT NULL DEFAULT 0,
                total_unindexed  INTEGER NOT NULL DEFAULT 0,
                UNIQUE (account_id, path_key)
            );
            CREATE TABLE IF NOT EXISTS messages (
                id            TEXT PRIMARY KEY,
                account_id    TEXT NOT NULL,
                folder_id     TEXT NOT NULL,
                uid           INTEGER NOT NULL,
                subject       TEXT NOT NULL DEFAULT '',
                from_json     TEXT NOT NULL DEFAULT '{}',
                to_json       TEXT NOT NULL DEFAULT '[]',
                cc_json       TEXT NOT NULL DEFAULT '[]',
                date          TEXT NOT NULL DEFAULT '',
                seen          INTEGER NOT NULL DEFAULT 0,
                flagged       INTEGER NOT NULL DEFAULT 0,
                answered      INTEGER NOT NULL DEFAULT 0,
                deleted       INTEGER NOT NULL DEFAULT 0,
                has_attachments INTEGER NOT NULL DEFAULT 0,
                size          INTEGER NOT NULL DEFAULT 0,
                preview       TEXT NOT NULL DEFAULT '',
                malformed     TEXT NOT NULL DEFAULT '',
                rfc_message_id TEXT NOT NULL DEFAULT '',
                authres_json  TEXT NOT NULL DEFAULT '',
                priority      TEXT NOT NULL DEFAULT '',
                priority_source TEXT NOT NULL DEFAULT '',
                priority_reason TEXT NOT NULL DEFAULT '',
                -- Which message this one answers: `digest_of("reply", …)` of
                -- its `In-Reply-To`. A lookup key, never read back as a value.
                reply_key     TEXT NOT NULL DEFAULT '',
                UNIQUE (folder_id, uid)
            );
            CREATE INDEX IF NOT EXISTS messages_by_folder ON messages (folder_id, date DESC);
            CREATE TABLE IF NOT EXISTS bodies_cache (
                message_id  TEXT PRIMARY KEY,
                version     INTEGER NOT NULL,
                html        TEXT,
                text        TEXT,
                links_json  TEXT NOT NULL DEFAULT '[]',
                remote_refs INTEGER NOT NULL DEFAULT 0,
                truncated   INTEGER NOT NULL DEFAULT 0,
                raw_blob    TEXT
            );
            CREATE TABLE IF NOT EXISTS attachments (
                message_id TEXT NOT NULL,
                part_id    TEXT NOT NULL,
                filename   TEXT NOT NULL,
                mime       TEXT NOT NULL,
                size       INTEGER NOT NULL,
                inline     INTEGER NOT NULL DEFAULT 0,
                mismatch   TEXT,
                blob       TEXT NOT NULL,
                PRIMARY KEY (message_id, part_id)
            );
            CREATE TABLE IF NOT EXISTS drafts (
                id         TEXT PRIMARY KEY,
                account_id TEXT NOT NULL,
                json       TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS staged (
                draft_id  TEXT NOT NULL,
                staged_id TEXT NOT NULL,
                filename  TEXT NOT NULL,
                mime      TEXT NOT NULL,
                size      INTEGER NOT NULL,
                PRIMARY KEY (draft_id, staged_id)
            );
            CREATE TABLE IF NOT EXISTS mail_remote_allow (
                addr_key TEXT PRIMARY KEY,
                address  TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS agent_marks (
                message_id TEXT PRIMARY KEY,
                account_id TEXT NOT NULL,
                mid_key    TEXT NOT NULL DEFAULT '',
                marked_at  TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS agent_marks_mid ON agent_marks(account_id, mid_key);
            "#,
        )
        .map_err(|e| e.to_string())?;
        // Additive column for a store created before it existed. `CREATE TABLE
        // IF NOT EXISTS` is a no-op on an existing table, so a dev database from
        // an earlier run would otherwise keep the old shape forever. A column
        // already there is skipped ([`add_column_if_missing`]); any other
        // failure stops the open rather than leaving the store half-migrated.
        add_column_if_missing(&conn, "messages", "rfc_message_id", "TEXT NOT NULL DEFAULT ''")?;
        add_column_if_missing(&conn, "messages", "authres_json", "TEXT NOT NULL DEFAULT ''")?;
        add_column_if_missing(&conn, "messages", "priority", "TEXT NOT NULL DEFAULT ''")?;
        // #205 provenance. Sealable (a model's reason quotes the message), so
        // they are read through `open_text` like every other value column — but
        // additive, for the reason the `priority` ALTER above documents: a dev
        // database from before they existed keeps its old shape otherwise.
        add_column_if_missing(&conn, "messages", "priority_source", "TEXT NOT NULL DEFAULT ''")?;
        add_column_if_missing(&conn, "messages", "priority_reason", "TEXT NOT NULL DEFAULT ''")?;
        // The Important/Urgent lists span every account and folder, so their only
        // WHERE is this column; unindexed, that is a full scan of the whole
        // mailbox on every page and every badge refresh.
        //
        // It is created HERE and deliberately not in the batch above. The batch
        // runs before this ALTER, so on a database that predates the column an
        // index naming it fails — and `execute_batch` is fallible-and-propagated,
        // so that failure would not be a missing index, it would be a mail store
        // that no longer opens. Every existing install takes exactly that path.
        conn.execute(
            "CREATE INDEX IF NOT EXISTS messages_by_priority ON messages (priority, date DESC)",
            [],
        )
        .map_err(|e| e.to_string())?;
        // "Your replies to this message" looks a message's answers up by this
        // key. Additive and indexed after its ALTER, for the reasons above.
        add_column_if_missing(&conn, "messages", "reply_key", "TEXT NOT NULL DEFAULT ''")?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS messages_by_reply_key ON messages (reply_key)
             WHERE reply_key != ''",
            [],
        )
        .map_err(|e| e.to_string())?;
        // Who staged a file and, for an agent's, where it came from
        // (`<project name>/<relative path>`, sealable). Additive for the reason
        // the `priority` ALTER documents; `''` reads as unset, so every row
        // staged before these existed is the user's own pick.
        add_column_if_missing(&conn, "staged", "origin", "TEXT NOT NULL DEFAULT ''")?;
        add_column_if_missing(&conn, "staged", "source", "TEXT NOT NULL DEFAULT ''")?;
        // v1 → v2. Both of these moved a `UNIQUE`/`PRIMARY KEY` off a column that
        // became sealable and onto a keyed digest beside it, which SQLite cannot
        // express as an `ALTER` — a constraint change is a table rebuild. The
        // rows are copied through Rust rather than through `INSERT … SELECT`
        // because the new key column is a *keyed* digest of the old value, which
        // SQL has no function for.
        //
        // Guarded on the column's existence rather than on the recorded schema
        // version, for the reason the priority ALTER above documents: a dev
        // database can be in any half-state, and "does the column exist" is a
        // question with one true answer where "what does `meta` claim" is a
        // question about a row that may have been written before a crash.
        if !column_exists(&conn, "folders", "path_key")? {
            let old: Vec<(String, String, String, String, String, i64, i64)> = {
                let mut stmt = conn
                    .prepare("SELECT id, account_id, path, name, kind, unread, total FROM folders")
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map([], |r| {
                        Ok((
                            r.get(0)?,
                            r.get(1)?,
                            r.get(2)?,
                            r.get(3)?,
                            r.get(4)?,
                            r.get(5)?,
                            r.get(6)?,
                        ))
                    })
                    .map_err(|e| e.to_string())?;
                rows.collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?
            };
            conn.execute_batch(
                r#"
                ALTER TABLE folders RENAME TO folders_v1;
                CREATE TABLE folders (
                    id         TEXT PRIMARY KEY,
                    account_id TEXT NOT NULL,
                    path_key   TEXT NOT NULL,
                    path       TEXT NOT NULL,
                    name       TEXT NOT NULL,
                    kind       TEXT NOT NULL,
                    unread     INTEGER NOT NULL DEFAULT 0,
                    total      INTEGER NOT NULL DEFAULT 0,
                    UNIQUE (account_id, path_key)
                );
                "#,
            )
            .map_err(|e| e.to_string())?;
            for (id, account_id, path, name, kind, unread, total) in old {
                // The values are still cleartext at this point — `seal_existing`
                // runs after `migrate` and seals them in place. Copying them
                // verbatim here is what keeps the two steps independent, and
                // therefore each one restartable on its own.
                conn.execute(
                    "INSERT OR REPLACE INTO folders
                        (id, account_id, path_key, path, name, kind, unread, total)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                    params![
                        id,
                        account_id,
                        self.digest_of(&account_id, &path),
                        path,
                        name,
                        kind,
                        unread,
                        total
                    ],
                )
                .map_err(|e| e.to_string())?;
            }
            conn.execute_batch("DROP TABLE folders_v1;")
                .map_err(|e| e.to_string())?;
        }
        if !column_exists(&conn, "mail_remote_allow", "addr_key")? {
            let old: Vec<String> = {
                let mut stmt = conn
                    .prepare("SELECT address FROM mail_remote_allow")
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map([], |r| r.get::<_, String>(0))
                    .map_err(|e| e.to_string())?;
                rows.collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?
            };
            conn.execute_batch(
                r#"
                ALTER TABLE mail_remote_allow RENAME TO mail_remote_allow_v1;
                CREATE TABLE mail_remote_allow (
                    addr_key TEXT PRIMARY KEY,
                    address  TEXT NOT NULL
                );
                "#,
            )
            .map_err(|e| e.to_string())?;
            for address in old {
                conn.execute(
                    "INSERT OR REPLACE INTO mail_remote_allow (addr_key, address) VALUES (?1, ?2)",
                    params![self.digest_of("mail_remote_allow", &address), address],
                )
                .map_err(|e| e.to_string())?;
            }
            conn.execute_batch("DROP TABLE mail_remote_allow_v1;")
                .map_err(|e| e.to_string())?;
        }
        // Additive, and after the v1 → v2 folders rebuild above, whose new table
        // does not carry them.
        add_column_if_missing(&conn, "folders", "unread_unindexed", "INTEGER NOT NULL DEFAULT 0")?;
        add_column_if_missing(&conn, "folders", "total_unindexed", "INTEGER NOT NULL DEFAULT 0")?;
        // Rows written before `upsert_header` normalized `date` to UTC still
        // carry the sender's offset and sort out of order (see there). Only mail
        // a sync fetches again would be rewritten, so they are converted here.
        // Idempotent: a converted row ends in `Z` and is not matched again.
        conn.execute(
            "UPDATE messages SET date = strftime('%Y-%m-%dT%H:%M:%SZ', date)
             WHERE date <> '' AND date NOT LIKE '%Z'
               AND strftime('%Y-%m-%dT%H:%M:%SZ', date) IS NOT NULL",
            [],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?1)",
            params![SCHEMA_VERSION.to_string()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    // ── Blobs ───────────────────────────────────────────────────────────────

    /// The name `bytes` are stored under.
    ///
    /// `SHA-256(plaintext)` in a plain store — content-addressed, opaque, and
    /// carrying no trace of a sender-supplied filename, which is the property
    /// the blob directory was built for. `HMAC-SHA256(k_addr, plaintext)` in an
    /// encrypted one, which keeps *all* of that and closes two further holes:
    /// the bare digest is a confirmation oracle (hash a file you suspect
    /// somebody received, look for its name in a directory listing), and a
    /// digest of the *ciphertext* could not dedupe at all, because two seals of
    /// identical bytes differ.
    ///
    /// Both are 64 hex characters, so [`MailStore::get_blob`]'s validation is
    /// unchanged — it now means something different.
    fn blob_name(keys: Option<&MailKeys>, bytes: &[u8]) -> String {
        match keys {
            Some(k) => mail_crypt::blob_id(&k.addr, bytes),
            None => crate::digest::sha256_hex(bytes),
        }
    }

    /// Store `bytes` under their content address and return it.
    ///
    /// Under `conn`, like every other write: the name and the seal come from
    /// the keys of the moment, and a re-key's blob pass ([`MailStore::rekey_step`])
    /// cannot run between choosing them and the file landing.
    pub fn put_blob(&self, bytes: &[u8]) -> Result<String, String> {
        let _conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let keys = self.keys();
        let hex = Self::blob_name(keys.as_deref(), bytes);
        let dir = self.blobs_dir();
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        harden(&dir, 0o700);
        let path = dir.join(&hex);
        if !path.exists() {
            let payload = match keys.as_deref() {
                Some(k) => mail_crypt::seal(&k.blob, &mail_crypt::blob_aad(&hex), bytes),
                None => bytes.to_vec(),
            };
            write_store_file(&path, &payload)?;
        }
        Ok(hex)
    }

    pub fn get_blob(&self, digest: &str) -> Result<Vec<u8>, String> {
        let digest = sanitize_id(digest);
        if digest.len() != 64 || !digest.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("not a blob id".into());
        }
        let raw = std::fs::read(self.blobs_dir().join(&digest)).map_err(|e| e.to_string())?;
        match self.keys().as_deref() {
            Some(k) => k
                .open_any(|k| &k.blob, &mail_crypt::blob_aad(&digest), &raw)
                .map(|(p, _)| p.to_vec())
                .map_err(|e| e.to_string()),
            None => Ok(raw),
        }
    }

    // ── Folders ─────────────────────────────────────────────────────────────

    /// Insert or update one folder row.
    ///
    /// Two conflict targets, because the row has two identities and they can
    /// disagree. `(account_id, path_key)` is the keyed one this table was
    /// rebuilt around; `id` is the caller's `sha256`-derived name for the same
    /// folder ([`commands::mail::folder_id_for`]), and it is *unkeyed*, so it
    /// survives changes of key that `path_key` does not. A row whose `path_key`
    /// was computed under different keys — a store that ran plain and was
    /// sealed later, a key that was reset — matches neither the new digest nor
    /// nothing at all: it matches on `id` alone, and with a single conflict
    /// clause the insert fell through to the primary key and every sync died on
    /// *"UNIQUE constraint failed: folders.id"*. The second clause makes that
    /// case an update that rewrites the stale key, so the row repairs itself
    /// even if [`MailStore::rekey_digest_columns`] never ran.
    pub fn upsert_folder(&self, folder: &MailFolder) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        conn.execute(
            "INSERT INTO folders (id, account_id, path_key, path, name, kind, unread, total)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(account_id, path_key) DO UPDATE SET
                path = excluded.path, name = excluded.name, kind = excluded.kind,
                unread = excluded.unread, total = excluded.total
             ON CONFLICT(id) DO UPDATE SET
                path_key = excluded.path_key, path = excluded.path,
                name = excluded.name, kind = excluded.kind,
                unread = excluded.unread, total = excluded.total",
            params![
                folder.id,
                folder.account_id,
                self.digest_of(&folder.account_id, &folder.path),
                self.seal_text(
                    &folder.account_id,
                    "folders",
                    "path",
                    &folder.id,
                    &folder.path
                ),
                self.seal_text(
                    &folder.account_id,
                    "folders",
                    "name",
                    &folder.id,
                    &folder.name
                ),
                folder.kind.as_str(),
                folder.unread,
                folder.total
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// One folder row, with its two sealed columns opened.
    ///
    /// A path that will not open reads as empty rather than failing the whole
    /// list: one damaged row must not make a mailbox unbrowsable, and the
    /// folder's `id` — which is cleartext and is what every other query joins on
    /// — is unaffected.
    fn row_to_folder(&self, r: &Row<'_>) -> rusqlite::Result<MailFolder> {
        let id: String = r.get(0)?;
        let account_id: String = r.get(1)?;
        Ok(MailFolder {
            path: self
                .open_text(r, 2, &account_id, "folders", "path", &id)?
                .unwrap_or_default(),
            name: self
                .open_text(r, 3, &account_id, "folders", "name", &id)?
                .unwrap_or_default(),
            kind: MailFolderKind::from_str_lossy(&r.get::<_, String>(4)?),
            unread: r.get(5)?,
            total: r.get(6)?,
            id,
            account_id,
        })
    }

    pub fn folders(&self, account_id: &str) -> Result<Vec<MailFolder>, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let mut stmt = conn
            .prepare(
                "SELECT id, account_id, path, name, kind, unread, total
                 FROM folders WHERE account_id = ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![account_id], |r| self.row_to_folder(r))
            .map_err(|e| e.to_string())?;
        let mut all: Vec<MailFolder> = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        // Ordered here rather than in SQL: `ORDER BY path` over a sealed column
        // would sort by ciphertext, i.e. at random, and a folder list whose order
        // changed on every sync would be its own bug report. The list is one
        // account's folders — tens of rows — so this costs nothing.
        all.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(all)
    }

    /// The `From:` of every indexed Inbox message across all accounts, newest
    /// first, at most `cap` rows — what the Address Book's "Add from Inbox"
    /// harvests. Only locally indexed mail: this never reaches a server. A row
    /// whose sealed sender cannot be opened is skipped, not guessed at.
    pub fn inbox_senders(&self, cap: u32) -> Result<Vec<MailAddress>, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let mut stmt = conn
            .prepare(
                "SELECT m.id, m.account_id, m.from_json FROM messages m
                 JOIN folders f ON f.id = m.folder_id
                 WHERE f.kind = ?1 AND m.deleted = 0
                 ORDER BY m.date DESC LIMIT ?2",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![MailFolderKind::Inbox.as_str(), cap], |r| {
                let id: String = r.get(0)?;
                let account_id: String = r.get(1)?;
                self.open_text(r, 2, &account_id, "messages", "from_json", &id)
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            let Some(json) = row.map_err(|e| e.to_string())? else { continue };
            if let Ok(addr) = serde_json::from_str::<MailAddress>(&json) {
                out.push(addr);
            }
        }
        Ok(out)
    }

    pub fn folder(&self, folder_id: &str) -> Result<Option<MailFolder>, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        conn.query_row(
            "SELECT id, account_id, path, name, kind, unread, total FROM folders WHERE id = ?1",
            params![folder_id],
            |r| self.row_to_folder(r),
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    /// Recompute a folder's counters from the rows actually stored, plus what
    /// the last sync found on the server beyond them
    /// ([`MailStore::set_server_counts`]).
    ///
    /// A sync indexes only a folder's newest headers, so the rows alone
    /// undercount any mailbox with unread mail older than that tail — the header
    /// badge read "the unread among the newest 100–200" rather than the unread.
    /// Local rows still carry every change made here (a read, a move) at once;
    /// the server's remainder only moves when a sync next measures it.
    pub fn refresh_counts(&self, folder_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        conn.execute(
            "UPDATE folders SET
               total  = total_unindexed
                        + (SELECT COUNT(*) FROM messages WHERE folder_id = ?1),
               unread = unread_unindexed
                        + (SELECT COUNT(*) FROM messages WHERE folder_id = ?1 AND seen = 0)
             WHERE id = ?1",
            params![folder_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Record the server's own counts for a folder a sync just fetched the
    /// newest headers of — call it after those headers are stored. What the
    /// index lacks is kept as the difference, never below zero: rows the server
    /// has since expunged, or read elsewhere past the tail, make the index
    /// overshoot, and an overshoot is not a negative remainder.
    pub fn set_server_counts(
        &self,
        folder_id: &str,
        server_total: u32,
        server_unread: u32,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        conn.execute(
            "UPDATE folders SET
               total_unindexed  = MAX(0, ?2
                 - (SELECT COUNT(*) FROM messages WHERE folder_id = ?1)),
               unread_unindexed = MAX(0, ?3
                 - (SELECT COUNT(*) FROM messages WHERE folder_id = ?1 AND seen = 0))
             WHERE id = ?1",
            params![folder_id, server_total, server_unread],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Unread mail the server has in this folder that the index holds no row
    /// for, as of the last sync.
    pub fn unindexed_unread(&self, folder_id: &str) -> Result<u32, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let n: Option<i64> = conn
            .query_row(
                "SELECT unread_unindexed FROM folders WHERE id = ?1",
                params![folder_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(n.unwrap_or(0) as u32)
    }

    // ── Headers ─────────────────────────────────────────────────────────────

    /// A move retains the local id (and encrypted body, marks and attachments),
    /// while the server gives it a new mailbox-scoped UID. Sync must reuse it.
    pub fn retain_header_id(&self, header: &mut MailHeader) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let id: Option<String> = conn
            .query_row(
                "SELECT id FROM messages WHERE folder_id = ?1 AND uid = ?2",
                params![header.folder_id, header.uid],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(id) = id {
            header.id = id;
        }
        Ok(())
    }

    /// Insert or update one header row. Returns `true` when the row was new,
    /// which is what the sync summary counts as a new message.
    pub fn upsert_header(&self, header: &MailHeader) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let existed: bool = conn
            .query_row(
                "SELECT 1 FROM messages WHERE id = ?1",
                params![header.id],
                |_| Ok(true),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or(false);
        // `date` is stored in UTC because every list orders by it as TEXT. The
        // parser hands back the sender's own offset, and RFC 3339 strings with
        // different offsets do not sort as the instants they name: a 06:00 at
        // `+02:00` sorted above a 09:00 sent as `03:00-04:00`. `strftime`
        // converts any offset to UTC and answers NULL for what it cannot read,
        // which keeps that value as it came rather than blanking it.
        conn.execute(
            "INSERT INTO messages (id, account_id, folder_id, uid, subject, from_json, to_json,
                                   cc_json, date, seen, flagged, answered, has_attachments,
                                   size, preview, malformed, rfc_message_id, authres_json)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', ?9), ?9),
                     ?10,?11,?12,?13,?14,?15,?16,?17,?18)
             ON CONFLICT(id) DO UPDATE SET
                subject = excluded.subject, from_json = excluded.from_json,
                to_json = excluded.to_json, cc_json = excluded.cc_json,
                date = excluded.date, seen = excluded.seen, flagged = excluded.flagged,
                answered = excluded.answered, has_attachments = excluded.has_attachments,
                size = excluded.size, preview = excluded.preview,
                malformed = excluded.malformed,
                rfc_message_id = excluded.rfc_message_id,
                authres_json = excluded.authres_json",
            // NOTE: `priority` is deliberately absent from BOTH halves. Absent
            // from the INSERT so a newly-synced message starts unmarked, and
            // absent from the `DO UPDATE SET` so a re-sync — which runs over
            // every message in a folder, every check — cannot wipe a mark the
            // user made. The mark is the one column here the *user* owns rather
            // than the server, so the server's copy must never overwrite it.
            params![
                header.id,
                header.account_id,
                header.folder_id,
                header.uid,
                self.seal_header(header, "subject", &header.subject),
                self.seal_header(
                    header,
                    "from_json",
                    &serde_json::to_string(&header.from).unwrap_or_default()
                ),
                self.seal_header(
                    header,
                    "to_json",
                    &serde_json::to_string(&header.to).unwrap_or_default()
                ),
                self.seal_header(
                    header,
                    "cc_json",
                    &serde_json::to_string(&header.cc).unwrap_or_default()
                ),
                header.date,
                header.seen as i64,
                header.flagged as i64,
                header.answered as i64,
                header.has_attachments as i64,
                header.size as i64,
                self.seal_header(header, "preview", &header.preview),
                self.seal_header(
                    header,
                    "malformed",
                    &header
                        .malformed_headers
                        .as_ref()
                        .map(|m| m.join(","))
                        .unwrap_or_default()
                ),
                self.seal_header(
                    header,
                    "rfc_message_id",
                    header.rfc_message_id.as_deref().unwrap_or_default()
                ),
                // The stored copy always carries the parsed data in its
                // `Unconfigured` state; the trust decision is re-derived on
                // every read (`row_to_header`), so changing the account's
                // trusted id re-judges already-synced mail with no re-sync.
                self.seal_header(
                    header,
                    "authres_json",
                    &header
                        .auth
                        .as_ref()
                        .and_then(|a| serde_json::to_string(a).ok())
                        .unwrap_or_default()
                ),
            ],
        )
        .map_err(|e| e.to_string())?;
        // A mark for agents follows the RFC `Message-ID`, not the store row: a
        // message re-indexed under a new `{folder}-{uid}` (a move, a
        // UIDVALIDITY change) arrives marked when a row of the same account with
        // the same id was. Only for a row that is new here, so a re-sync — every
        // message in a folder, every check — costs one indexed probe per *new*
        // message and nothing per known one.
        if !existed {
            // A mark left under this store id by an earlier message (the id
            // was reused after a delete) is that message's consent, not this
            // one's.
            conn.execute(
                "DELETE FROM agent_marks WHERE message_id = ?1",
                params![header.id],
            )
            .map_err(|e| e.to_string())?;
            let key = self.agent_mark_key(header);
            if !key.is_empty() {
                // Only a copy whose original has left the index is adopted. A
                // Message-ID is sender-chosen and known to every participant
                // of the thread, so a duplicate arriving while the original is
                // still indexed is not a move — it is someone else's message
                // wearing the marked one's id.
                conn.execute(
                    "INSERT OR IGNORE INTO agent_marks (message_id, account_id, mid_key, marked_at)
                     SELECT ?1, ?2, ?3, marked_at FROM agent_marks
                     WHERE account_id = ?2 AND mid_key = ?3
                       AND NOT EXISTS (SELECT 1 FROM agent_marks a2
                                       JOIN messages m ON m.id = a2.message_id
                                       WHERE a2.account_id = ?2 AND a2.mid_key = ?3
                                         AND m.deleted = 0)
                     LIMIT 1",
                    params![header.id, header.account_id, key],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        Ok(!existed)
    }

    fn seal_header(&self, header: &MailHeader, column: &str, value: &str) -> SqlValue {
        self.seal_text(&header.account_id, "messages", column, &header.id, value)
    }

    /// The `SELECT` list every header read shares, so a column added to one is
    /// added to all of them and `row_to_header`'s indices cannot drift.
    const HEADER_COLUMNS: &'static str = "id, account_id, folder_id, uid, subject, from_json, \
         to_json, cc_json, date, seen, flagged, answered, has_attachments, size, preview, \
         malformed, rfc_message_id, authres_json, priority, priority_source, priority_reason";

    /// One page of a folder's headers in the requested order, optionally
    /// filtered.
    ///
    /// The query is a `LIKE` over subject/sender/preview and is bound as a
    /// parameter — the caller's text never reaches the SQL string. The **order**
    /// cannot be bound (SQLite takes no parameter in an `ORDER BY`), which is
    /// exactly why `sort` is a `MailSort` and not a column name: `order_clause`
    /// maps the closed set onto fixed literals, so nothing the caller says is
    /// ever interpolated.
    ///
    /// Ordering here rather than in the list component is what makes it mean
    /// anything: the list is paged, so sorting on the frontend would order the
    /// hundred rows that happen to be on screen.
    pub fn headers_page(
        &self,
        folder_id: &str,
        offset: u32,
        limit: u32,
        query: Option<&str>,
        sort: MailSort,
        desc: bool,
        unread_only: bool,
    ) -> Result<MailHeaderPage, String> {
        self.page(
            "folder_id = ?1 AND deleted = 0",
            folder_id,
            offset,
            limit,
            query,
            sort,
            desc,
            unread_only,
            SearchFields::SubjectSenderPreview,
        )
    }

    /// [`headers_page`](Self::headers_page) over the messages marked for agents
    /// only — what a contained reader in `Marked` scope is served, and the
    /// mail view's "shared with agents" filter. The restriction is a fixed
    /// literal on the same query, so it pages, searches and sorts exactly like
    /// the folder does.
    #[allow(clippy::too_many_arguments)]
    pub fn headers_page_marked(
        &self,
        folder_id: &str,
        offset: u32,
        limit: u32,
        query: Option<&str>,
        sort: MailSort,
        desc: bool,
        unread_only: bool,
    ) -> Result<MailHeaderPage, String> {
        self.page(
            "folder_id = ?1 AND deleted = 0 AND id IN (SELECT message_id FROM agent_marks)",
            folder_id,
            offset,
            limit,
            query,
            sort,
            desc,
            unread_only,
            SearchFields::SubjectSenderPreview,
        )
    }

    /// The local half of `mail_search`, including its offline fallback. Match
    /// subject and sender only, just as IMAP `SUBJECT`/`FROM` does, so a cached
    /// preview cannot make the same query yield a different result offline.
    #[allow(clippy::too_many_arguments)]
    pub fn folder_search_page(
        &self,
        folder_id: &str,
        offset: u32,
        limit: u32,
        query: &str,
        sort: MailSort,
        desc: bool,
        unread_only: bool,
        agent_only: bool,
    ) -> Result<MailHeaderPage, String> {
        let scope = if agent_only {
            "folder_id = ?1 AND deleted = 0 AND id IN (SELECT message_id FROM agent_marks)"
        } else {
            "folder_id = ?1 AND deleted = 0"
        };
        self.page(
            scope,
            folder_id,
            offset,
            limit,
            Some(query),
            sort,
            desc,
            unread_only,
            SearchFields::SubjectSender,
        )
    }

    /// One page of whichever set `scope_where`/`scope_param` select.
    ///
    /// `headers_page` and `priority_page` both land here, which is what makes
    /// the claim in their docs — that the Important list "sorts, searches and
    /// pages exactly like a folder does" — a fact about the code rather than an
    /// intention. `scope_where` is a fixed literal supplied by this file and
    /// binds `?1`; nothing a caller says is ever formatted into SQL.
    ///
    /// # Searching an encrypted store
    ///
    /// `LIKE` cannot run over ciphertext, so a sealed store searches by
    /// **decrypt-on-scan**: walk the scope in the requested order, open
    /// `subject`/`from_json`/`preview` per row, keep the matches, and stop after
    /// [`MAX_SEARCH_SCAN`] rows. Two consequences, both deliberate and both
    /// surfaced rather than hidden:
    ///
    /// - `total` becomes *matches found within the scan*, not `COUNT(*)`. The
    ///   pager stops claiming a page count it cannot know.
    /// - `scanned` is set when the bound was hit, so the UI can say how much of
    ///   the mailbox the answer covers.
    ///
    /// With no query nothing is scanned at all — only the rows on the page are
    /// opened, which is the case that has to stay cheap.
    #[allow(clippy::too_many_arguments)]
    fn page(
        &self,
        scope_where: &'static str,
        scope_param: &str,
        offset: u32,
        limit: u32,
        query: Option<&str>,
        sort: MailSort,
        desc: bool,
        unread_only: bool,
        fields: SearchFields,
    ) -> Result<MailHeaderPage, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let limit = limit.clamp(1, 500);
        // A second fixed literal, never caller text. `seen` is a plain column
        // in a sealed store too, so the filter runs in SQL on both paths and
        // the pager counts only what it would show.
        let unread = if unread_only { " AND seen = 0" } else { "" };
        let needle = query.map(str::trim).filter(|q| !q.is_empty());

        // ── Encrypted + a query: decrypt-on-scan ────────────────────────────
        if self.is_encrypted() {
            if let Some(needle) = needle {
                let needle = needle.to_lowercase();
                let mut stmt = conn
                    .prepare(&format!(
                        "SELECT {} FROM messages WHERE {scope_where}{unread} ORDER BY {}",
                        Self::HEADER_COLUMNS,
                        Self::order_clause(sort, desc),
                    ))
                    .map_err(|e| e.to_string())?;
                let mut rows = stmt
                    .query(params![scope_param])
                    .map_err(|e| e.to_string())?;

                let mut items = Vec::new();
                let mut matched = 0u32;
                let mut looked_at = 0usize;
                let mut capped = false;
                while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                    if looked_at >= MAX_SEARCH_SCAN {
                        capped = true;
                        break;
                    }
                    looked_at += 1;
                    let header = self.row_to_header(row).map_err(|e| e.to_string())?;
                    let sender_hit = if fields == SearchFields::SubjectSender {
                        header
                            .from
                            .name
                            .as_deref()
                            .unwrap_or_default()
                            .to_lowercase()
                            .contains(&needle)
                            || header.from.address.to_lowercase().contains(&needle)
                    } else {
                        serde_json::to_string(&header.from)
                            .unwrap_or_default()
                            .to_lowercase()
                            .contains(&needle)
                    };
                    let hit = header.subject.to_lowercase().contains(&needle)
                        || sender_hit
                        || (fields == SearchFields::SubjectSenderPreview
                            && header.preview.to_lowercase().contains(&needle));
                    if !hit {
                        continue;
                    }
                    matched += 1;
                    if matched > offset && items.len() < limit as usize {
                        items.push(header);
                    }
                }
                return Ok(MailHeaderPage {
                    items,
                    total: matched,
                    scanned: capped.then_some(looked_at as u32),
                });
            }

            // Encrypted, no query: plain paging, no `LIKE` at all. Applying one
            // to a sealed column would be comparing a pattern against ciphertext
            // — never a match, and the empty folder it produced would look like
            // a sync bug rather than an encoding one.
            let total: u32 = conn
                .query_row(
                    &format!("SELECT COUNT(*) FROM messages WHERE {scope_where}{unread}"),
                    params![scope_param],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {} FROM messages WHERE {scope_where}{unread} ORDER BY {} LIMIT ?2 OFFSET ?3",
                    Self::HEADER_COLUMNS,
                    Self::order_clause(sort, desc),
                ))
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![scope_param, limit, offset], |r| {
                    self.row_to_header(r)
                })
                .map_err(|e| e.to_string())?;
            let items = rows
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            return Ok(MailHeaderPage {
                items,
                total,
                scanned: None,
            });
        }

        // ── Plain store: the bound `LIKE`, unchanged ────────────────────────
        let pattern = needle
            .map(|q| format!("%{}%", q.replace('%', "\\%").replace('_', "\\_")))
            .unwrap_or_else(|| "%".to_string());
        let filter = match fields {
            SearchFields::SubjectSenderPreview => {
                "AND (subject LIKE ?2 ESCAPE '\\' OR from_json LIKE ?2 ESCAPE '\\' \
                 OR preview LIKE ?2 ESCAPE '\\')"
            }
            SearchFields::SubjectSender => {
                "AND (subject LIKE ?2 ESCAPE '\\' \
                 OR (CASE WHEN json_valid(from_json) THEN json_extract(from_json, '$.name') END) LIKE ?2 ESCAPE '\\' \
                 OR (CASE WHEN json_valid(from_json) THEN json_extract(from_json, '$.address') END) LIKE ?2 ESCAPE '\\')"
            }
        };

        let total: u32 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM messages WHERE {scope_where}{unread} {filter}"),
                params![scope_param, pattern],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;

        let mut stmt = conn
            .prepare(&format!(
                "SELECT {} FROM messages WHERE {scope_where}{unread} {filter} ORDER BY {} LIMIT ?3 OFFSET ?4",
                Self::HEADER_COLUMNS,
                Self::order_clause(sort, desc),
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![scope_param, pattern, limit, offset], |r| {
                self.row_to_header(r)
            })
            .map_err(|e| e.to_string())?;
        let items = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(MailHeaderPage {
            items,
            total,
            scanned: None,
        })
    }

    /// The `ORDER BY` body for one sort, as a **fixed literal per variant**.
    ///
    /// Every branch returns a constant `&'static str`; nothing a caller supplies
    /// is formatted in, which is what keeps the one interpolated clause in this
    /// file safe. `desc` picks between two constants rather than being spliced.
    ///
    /// Two decisions live in the tie-breaks. Every non-date sort falls back to
    /// `date DESC, uid DESC`, because `flagged` and `has_attachments` are single
    /// bits and `size` collides freely — without a tie-break the order *within*
    /// a group would be whatever SQLite happened to scan, and it would change
    /// between two reads of an unchanged folder. And the tie-break stays
    /// newest-first even when the primary key is ascending: flipping to
    /// "smallest first" is a statement about size, not a request to read a
    /// mailbox backwards.
    fn order_clause(sort: MailSort, desc: bool) -> &'static str {
        match (sort, desc) {
            (MailSort::Date, true) => "date DESC, uid DESC",
            (MailSort::Date, false) => "date ASC, uid ASC",
            // Descending puts the starred mail on top, which is why every list
            // here defaults to it: `flagged DESC` is "flagged first", and a star
            // sort that opened on the unstarred majority would be useless.
            (MailSort::Flagged, true) => "flagged DESC, date DESC, uid DESC",
            (MailSort::Flagged, false) => "flagged ASC, date DESC, uid DESC",
            (MailSort::Attachments, true) => "has_attachments DESC, date DESC, uid DESC",
            (MailSort::Attachments, false) => "has_attachments ASC, date DESC, uid DESC",
            (MailSort::Size, true) => "size DESC, date DESC, uid DESC",
            (MailSort::Size, false) => "size ASC, date DESC, uid DESC",
        }
    }

    pub fn header(&self, message_id: &str) -> Result<Option<MailHeader>, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        conn.query_row(
            &format!(
                "SELECT {} FROM messages WHERE id = ?1",
                Self::HEADER_COLUMNS
            ),
            params![message_id],
            |r| self.row_to_header(r),
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    /// Record which message this one answers (its `In-Reply-To`), as the keyed
    /// digest `replies_to` looks up. Its own statement rather than a column of
    /// `upsert_header`, so `MailHeader` — the wire contract — does not grow a
    /// field nothing displays. A no-op once the key is in place, which on a
    /// re-sync is every row.
    pub fn set_reply_key(&self, message_id: &str, in_reply_to: Option<&str>) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let key = in_reply_to
            .map(normalize_rfc_id)
            .filter(|id| !id.is_empty())
            .map(|id| self.digest_of("reply", id))
            .unwrap_or_default();
        conn.execute(
            "UPDATE messages SET reply_key = ?1 WHERE id = ?2 AND reply_key != ?1",
            params![key, message_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// The answers the user already wrote to a message: mail in any account's
    /// Sent folder whose `In-Reply-To` names it, oldest first. Only what the
    /// local index holds — a reply sent from another client shows up once its
    /// Sent folder has synced. A message that carried no `Message-ID` has none.
    pub fn replies_to(&self, message_id: &str) -> Result<Vec<MailHeader>, String> {
        let Some(rfc_id) = self.header(message_id)?.and_then(|h| h.rfc_message_id) else {
            return Ok(Vec::new());
        };
        let rfc_id = normalize_rfc_id(&rfc_id);
        if rfc_id.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let key = self.digest_of("reply", rfc_id);
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {} FROM messages
                 WHERE reply_key = ?1 AND deleted = 0 AND id != ?2
                   AND folder_id IN (SELECT id FROM folders WHERE kind = 'sent')
                 ORDER BY date ASC, uid ASC LIMIT {MAX_REPLIES}",
                Self::HEADER_COLUMNS
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![key, message_id], |r| self.row_to_header(r))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    // ── Marks for agents (`docs/mail_mcp_plan.md` §1, "Marked mails only") ──
    //
    // A mark is the user's consent for a contained reader to see ONE message.
    // It is local: a row here and never an IMAP keyword, so "shared with an
    // agent" never reaches the provider or another client. The row carries the
    // store id (what the reader's queries join on) and a keyed digest of the
    // RFC `Message-ID` **and the sender address** (what lets `upsert_header`
    // carry the mark onto a re-indexed copy — and only onto one from the same
    // sender, since the id alone is a value every thread participant knows).
    // Like `reply_key`, the digest leaks equality and only equality, and
    // `rekey_digest_columns` maintains it across a sealing.

    /// The keyed digest that identifies `header`'s message across re-indexing,
    /// or `""` for a message that carried no `Message-ID`.
    fn agent_mark_key(&self, header: &MailHeader) -> String {
        let from = header.from.address.trim().to_lowercase();
        header
            .rfc_message_id
            .as_deref()
            .map(normalize_rfc_id)
            .filter(|id| !id.is_empty())
            .map(|id| self.digest_of("agent_mark", &format!("{id}\n{from}")))
            .unwrap_or_default()
    }

    /// Mark or unmark messages for agents. Returns how many rows changed.
    ///
    /// Unmarking removes every row of the same account with the same
    /// `Message-ID`, not only the id handed in: the mark is per message, and a
    /// copy left marked in another folder would be exactly the surprise the
    /// unmark was meant to end. A message no longer in the index changes
    /// nothing, and the count says so.
    pub fn agent_mark(&self, message_ids: &[String], marked: bool) -> Result<usize, String> {
        let mut changed = 0usize;
        for id in message_ids {
            let Some(header) = self.header(id)? else { continue };
            let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
            let key = self.agent_mark_key(&header);
            if marked {
                changed += conn
                    .execute(
                        "INSERT OR IGNORE INTO agent_marks (message_id, account_id, mid_key, marked_at)
                         VALUES (?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))",
                        params![header.id, header.account_id, key],
                    )
                    .map_err(|e| e.to_string())?;
            } else {
                changed += conn
                    .execute("DELETE FROM agent_marks WHERE message_id = ?1", params![header.id])
                    .map_err(|e| e.to_string())?;
                if !key.is_empty() {
                    changed += conn
                        .execute(
                            "DELETE FROM agent_marks WHERE account_id = ?1 AND mid_key = ?2",
                            params![header.account_id, key],
                        )
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        Ok(changed)
    }

    /// Mark every message of a folder. Returns how many were newly marked.
    pub fn agent_mark_folder(&self, folder_id: &str) -> Result<usize, String> {
        let ids: Vec<String> = {
            let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
            let mut stmt = conn
                .prepare("SELECT id FROM messages WHERE folder_id = ?1 AND deleted = 0")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![folder_id], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
        };
        self.agent_mark(&ids, true)
    }

    /// Mark every message of an account whose `From` address is `address`
    /// (case-insensitive), in any folder. Returns how many were newly marked.
    ///
    /// `From` is a sealed column, so this is a decrypt-on-scan over the account
    /// like a search is, bounded by [`MAX_SEARCH_SCAN`] newest-first for the
    /// same reason.
    pub fn agent_mark_sender(&self, account_id: &str, address: &str) -> Result<usize, String> {
        let wanted = address.trim().to_lowercase();
        if wanted.is_empty() {
            return Ok(0);
        }
        let ids: Vec<String> = {
            let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {} FROM messages WHERE account_id = ?1 AND deleted = 0 ORDER BY date DESC",
                    Self::HEADER_COLUMNS
                ))
                .map_err(|e| e.to_string())?;
            let mut rows = stmt.query(params![account_id]).map_err(|e| e.to_string())?;
            let mut ids = Vec::new();
            let mut looked_at = 0usize;
            while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                if looked_at >= MAX_SEARCH_SCAN {
                    break;
                }
                looked_at += 1;
                let header = self.row_to_header(row).map_err(|e| e.to_string())?;
                if header.from.address.trim().to_lowercase() == wanted {
                    ids.push(header.id);
                }
            }
            ids
        };
        self.agent_mark(&ids, true)
    }

    /// Whether one message is marked for agents. A mark whose message left the
    /// index (a purge, a re-index not yet re-adopted) does not count.
    pub fn agent_marked(&self, message_id: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        conn.query_row(
            "SELECT 1 FROM agent_marks a JOIN messages m ON m.id = a.message_id
             WHERE a.message_id = ?1 AND m.deleted = 0",
            params![message_id],
            |_| Ok(true),
        )
        .optional()
        .map(|found| found.unwrap_or(false))
        .map_err(|e| e.to_string())
    }

    /// The ids of an account's marked messages that are in the index — what the
    /// mail view draws its mark from.
    pub fn agent_marks(&self, account_id: &str) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let mut stmt = conn
            .prepare(
                "SELECT a.message_id FROM agent_marks a JOIN messages m ON m.id = a.message_id
                 WHERE a.account_id = ?1 AND m.deleted = 0",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![account_id], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// Per folder of an account: `(folder_id, unread, total)` over the marked
    /// messages only — the counts a reader in `Marked` scope is shown. Folders
    /// with no marked message are absent (they count as zero).
    pub fn agent_marked_counts(&self, account_id: &str) -> Result<Vec<(String, u32, u32)>, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let mut stmt = conn
            .prepare(
                "SELECT m.folder_id, SUM(CASE WHEN m.seen = 0 THEN 1 ELSE 0 END), COUNT(*)
                 FROM agent_marks a JOIN messages m ON m.id = a.message_id
                 WHERE a.account_id = ?1 AND m.deleted = 0 GROUP BY m.folder_id",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![account_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u32, r.get::<_, i64>(2)? as u32))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn set_flag(&self, message_id: &str, flag: MailFlag, value: bool) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        // `flag.column()` is a fixed `&'static str` per enum variant, so this
        // is the one place a column name is formatted into SQL and nothing
        // caller-controlled can reach it.
        let sql = format!("UPDATE messages SET {} = ?1 WHERE id = ?2", flag.column());
        conn.execute(&sql, params![value as i64, message_id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// The server-side UIDs of everything still unread in a folder.
    ///
    /// Read **before** the local rows are flipped, because it is what the IMAP
    /// half of "mark all as read" addresses — flipping first and then asking
    /// would return nothing and quietly turn the operation local-only.
    pub fn unseen_uids(&self, folder_id: &str) -> Result<Vec<u32>, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let mut stmt = conn
            .prepare("SELECT uid FROM messages WHERE folder_id = ?1 AND seen = 0 ORDER BY uid")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![folder_id], |r| r.get::<_, i64>(0))
            .map_err(|e| e.to_string())?;
        let mut uids = Vec::new();
        for r in rows {
            uids.push(r.map_err(|e| e.to_string())? as u32);
        }
        Ok(uids)
    }

    /// The highest UID stored for a folder, or `None` when the folder holds no
    /// messages yet.
    ///
    /// This is the sync loop's **arrival watermark**. IMAP UIDs rise
    /// monotonically within a folder, so a message whose UID exceeds every one
    /// we have already seen is one that *arrived* since the last check — as
    /// opposed to one merely inserted into the local index for the first time,
    /// which every message in the initial backlog of a folder also is. The
    /// keyword filters must fire only on the former: `None` here (a folder's
    /// first sync) means "everything present is history", and the caller files
    /// none of it. The alternative — treating first-insert as arrival — marks a
    /// user's entire mail history the moment a rule exists before the folder is
    /// first pulled, which is exactly the "apply to existing" the user did not
    /// ask for.
    pub fn folder_max_uid(&self, folder_id: &str) -> Result<Option<u32>, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let max: Option<i64> = conn
            .query_row(
                "SELECT MAX(uid) FROM messages WHERE folder_id = ?1",
                params![folder_id],
                |r| r.get::<_, Option<i64>>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .flatten();
        Ok(max.map(|m| m as u32))
    }

    /// Of these UIDs, the ones this folder's index holds no row for — what a
    /// server search still has to download before the local page can answer.
    ///
    /// A search keystroke re-runs the server query from scratch, so without
    /// this every keystroke would re-fetch every match: usually the longer
    /// query's matches are a subset of the shorter one's, and the ones already
    /// here cost nothing. Chunked to stay under SQLite's variable limit.
    pub fn missing_uids(&self, folder_id: &str, uids: &[u32]) -> Result<Vec<u32>, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let mut missing = Vec::new();
        for chunk in uids.chunks(500) {
            if chunk.is_empty() {
                continue;
            }
            let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let sql = format!(
                "SELECT uid FROM messages WHERE folder_id = ?1 AND uid IN ({placeholders})"
            );
            let mut params: Vec<&dyn ToSql> = Vec::with_capacity(chunk.len() + 1);
            params.push(&folder_id);
            for uid in chunk {
                params.push(uid);
            }
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let have: std::collections::HashSet<i64> = stmt
                .query_map(params.as_slice(), |r| r.get(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<_, _>>()
                .map_err(|e| e.to_string())?;
            missing.extend(chunk.iter().filter(|u| !have.contains(&(**u as i64))));
        }
        Ok(missing)
    }

    /// Account rows a server search backfilled into the index, so the folder's
    /// badges do not count them twice.
    ///
    /// `total`/`unread` are the indexed rows *plus* the server remainder
    /// (`refresh_counts`), and that remainder was measured when these rows
    /// were still beyond the index — every row now stored has to leave it, or
    /// the folder's total grows by each searched mail. Floored at zero: rows
    /// the server has since expunged can make the index overshoot, and an
    /// overshoot is not a negative remainder (the same rule as
    /// `set_server_counts`).
    pub fn note_indexed(
        &self,
        folder_id: &str,
        inserted: u32,
        inserted_unseen: u32,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        conn.execute(
            "UPDATE folders SET
               total_unindexed  = MAX(0, total_unindexed - ?2),
               unread_unindexed = MAX(0, unread_unindexed - ?3)
             WHERE id = ?1",
            params![folder_id, inserted, inserted_unseen],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Mark every unread message in a folder read, locally. Returns how many
    /// rows actually changed, which is the number the UI reports — a folder
    /// already fully read answers 0 rather than claiming work it did not do.
    pub fn mark_folder_seen(&self, folder_id: &str) -> Result<u32, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let changed = conn
            .execute(
                "UPDATE messages SET seen = 1 WHERE folder_id = ?1 AND seen = 0",
                params![folder_id],
            )
            .map_err(|e| e.to_string())?;
        // The unread beyond the index goes too: the command marks it on the
        // server through the newest indexed UID (`mark_seen_through`).
        conn.execute(
            "UPDATE folders SET unread_unindexed = 0 WHERE id = ?1",
            params![folder_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(changed as u32)
    }

    // ── Priority marks (Important / Urgent) ─────────────────────────────────

    /// Set — or with `None`, clear — one message's local priority mark.
    ///
    /// The value written is `MailPriority::as_str()`, a fixed literal per
    /// variant, and it is **bound**, not formatted: this is a data column, not
    /// the `ORDER BY` clause, so nothing here needs `order_clause`'s treatment.
    ///
    /// A message that is not in the index is not an error to shout about — it
    /// answers `false`, so a caller can tell "nothing changed" from "done". The
    /// realistic way to get there is marking a message and having the folder
    /// re-synced out from under it.
    pub fn set_priority(
        &self,
        message_id: &str,
        priority: Option<MailPriority>,
    ) -> Result<bool, String> {
        // A bare `set_priority` is the user's own hand — the right-click menu and
        // `mail_priority_set`. The filter and the model call `set_priority_ex`
        // with their own provenance, so the classifier can never masquerade as a
        // hand-mark (or as a keyword rule).
        self.set_priority_ex(message_id, priority, MailPrioritySource::User, "")
    }

    /// [`set_priority`], but recording **who** set the mark and **why** (#205).
    ///
    /// `source`/`reason` are sealed alongside every other value column when the
    /// store has keys — a model's reason quotes the message, which says as much
    /// as a subject line. Clearing the mark (`priority = None`) also clears the
    /// provenance, so a message the user un-marks carries no stale "the model
    /// said…" behind it.
    ///
    /// The AAD binds each sealed value to this message's `account_id`, which is
    /// read from the row itself; a message not in the index changes nothing and
    /// answers `false`, exactly as [`set_priority`] does.
    pub fn set_priority_ex(
        &self,
        message_id: &str,
        priority: Option<MailPriority>,
        source: MailPrioritySource,
        reason: &str,
    ) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let Some(account_id) = conn
            .query_row(
                "SELECT account_id FROM messages WHERE id = ?1",
                params![message_id],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
        else {
            return Ok(false);
        };
        let value = priority.map(|p| p.as_str()).unwrap_or("");
        // Provenance is only meaningful while a mark is set; a cleared mark
        // stores empty strings so nothing is left behind.
        let (src, rsn) = match priority {
            Some(_) => (source.as_str(), reason),
            None => ("", ""),
        };
        let src_v = self.seal_text(&account_id, "messages", "priority_source", message_id, src);
        let rsn_v = self.seal_text(&account_id, "messages", "priority_reason", message_id, rsn);
        let changed = conn
            .execute(
                "UPDATE messages SET priority = ?1, priority_source = ?2, priority_reason = ?3 \
                 WHERE id = ?4",
                params![value, src_v, rsn_v, message_id],
            )
            .map_err(|e| e.to_string())?;
        Ok(changed > 0)
    }

    /// The newest **unmarked** messages a filter rule could still act on.
    ///
    /// Backs "apply my rules to mail I already have", and its three restrictions
    /// are the whole of that command's safety:
    ///
    /// - `priority = ''` — a message the user (or an earlier run) already filed
    ///   is never re-examined, so applying rules cannot overwrite a correction.
    /// - **`sent`/`drafts`/`trash`/`junk` are excluded**, as a fixed literal
    ///   list. A rule watching for the word *invoice* would otherwise pull every
    ///   invoice the user ever wrote into their alert list, and mail the server
    ///   already judged spam is the last thing an urgency list should surface.
    ///   Folders of *any other kind* — including `other`, i.e. everything the
    ///   user's own server-side rules sort into — are in scope, because those are
    ///   exactly where the interesting mail has been filed.
    /// - `limit`, clamped, ordered newest-first. This is a decrypt-per-row scan
    ///   on a sealed store (the `page` doc explains why nothing else is
    ///   possible), so it is bounded for the same reason a search is, and the
    ///   caller reports the bound rather than implying whole-mailbox coverage.
    pub fn unmarked_headers(
        &self,
        account_id: Option<&str>,
        limit: u32,
    ) -> Result<Vec<MailHeader>, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let limit = limit.clamp(1, MAX_SEARCH_SCAN as u32);
        // Both branches are fixed literals differing only in one bound clause;
        // nothing a caller says is formatted into the SQL.
        const SCOPE: &str = "priority = '' AND deleted = 0 AND folder_id NOT IN \
             (SELECT id FROM folders WHERE kind IN ('sent','drafts','trash','junk'))";
        let rows = match account_id {
            Some(account) => {
                let mut stmt = conn
                    .prepare(&format!(
                        "SELECT {} FROM messages WHERE {SCOPE} AND account_id = ?1 \
                         ORDER BY date DESC, uid DESC LIMIT ?2",
                        Self::HEADER_COLUMNS
                    ))
                    .map_err(|e| e.to_string())?;
                let iter = stmt
                    .query_map(params![account, limit], |r| self.row_to_header(r))
                    .map_err(|e| e.to_string())?;
                iter.collect::<Result<Vec<_>, _>>()
            }
            None => {
                let mut stmt = conn
                    .prepare(&format!(
                        "SELECT {} FROM messages WHERE {SCOPE} \
                         ORDER BY date DESC, uid DESC LIMIT ?1",
                        Self::HEADER_COLUMNS
                    ))
                    .map_err(|e| e.to_string())?;
                let iter = stmt
                    .query_map(params![limit], |r| self.row_to_header(r))
                    .map_err(|e| e.to_string())?;
                iter.collect::<Result<Vec<_>, _>>()
            }
        };
        rows.map_err(|e| e.to_string())
    }

    /// One page of everything carrying `priority`, **across every account and
    /// every folder**.
    ///
    /// That cross-account span is the whole reason the mark is a local column
    /// rather than an IMAP move: no folder on any server can hold mail from two
    /// accounts, so the list this query backs could not exist server-side at
    /// all. It is otherwise deliberately the twin of `headers_page` — same
    /// `LIKE` filter bound as a parameter, same closed-set `order_clause`, same
    /// `deleted = 0` — so the Important list sorts, searches and pages exactly
    /// like a folder does and the frontend needs no second code path.
    pub fn priority_page(
        &self,
        priority: MailPriority,
        offset: u32,
        limit: u32,
        query: Option<&str>,
        sort: MailSort,
        desc: bool,
        unread_only: bool,
    ) -> Result<MailHeaderPage, String> {
        self.page(
            "priority = ?1 AND deleted = 0",
            priority.as_str(),
            offset,
            limit,
            query,
            sort,
            desc,
            unread_only,
            SearchFields::SubjectSenderPreview,
        )
    }

    /// How much marked mail there is, for the rail's two badges.
    ///
    /// One statement rather than four, because it feeds one render: the badges
    /// would otherwise disagree for as long as it took the second read to land.
    /// Counts **everything** marked, not just the unread — a list you file mail
    /// into is not an inbox, and a badge that emptied itself as you read would
    /// stop reporting the thing it exists to report. The unread halves come back
    /// beside it for the rail to tone with.
    pub fn priority_counts(&self) -> Result<MailPriorityCounts, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        conn.query_row(
            "SELECT
               SUM(priority = 'important'),
               SUM(priority = 'urgent'),
               SUM(priority = 'important' AND seen = 0),
               SUM(priority = 'urgent' AND seen = 0)
             FROM messages WHERE deleted = 0",
            [],
            |r| {
                Ok(MailPriorityCounts {
                    // An empty table makes every SUM NULL, which is a count of
                    // zero and not a failure — hence the per-column default.
                    important: r.get::<_, Option<i64>>(0)?.unwrap_or(0) as u32,
                    urgent: r.get::<_, Option<i64>>(1)?.unwrap_or(0) as u32,
                    important_unread: r.get::<_, Option<i64>>(2)?.unwrap_or(0) as u32,
                    urgent_unread: r.get::<_, Option<i64>>(3)?.unwrap_or(0) as u32,
                })
            },
        )
        .map_err(|e| e.to_string())
    }

    /// Clear the mark from **every** message carrying `priority` — emptying one
    /// of the two lists in a single action — answering how many rows changed.
    ///
    /// One statement rather than a read-then-`set_priority`-per-row, and the two
    /// provenance columns go back to a plain `''`: they are sealed only while a
    /// mark is *set* (a model's reason quotes the message), and an empty value
    /// has nothing to hide — which is exactly why `open_text` reads a text cell
    /// straight through even in a sealed store. Deliberately **not** filtered on
    /// `deleted`: a mark left on a message that is already gone from the index
    /// is precisely the kind of leftover this action exists to get rid of, and
    /// it is invisible to the count the user is shown either way.
    pub fn clear_priority(&self, priority: MailPriority) -> Result<u32, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        // The value is bound, not formatted — `set_priority`'s rule, for the
        // same reason: this is a data column, not the `ORDER BY` clause.
        let changed = conn
            .execute(
                "UPDATE messages SET priority = '', priority_source = '', priority_reason = '' \
                 WHERE priority = ?1",
                params![priority.as_str()],
            )
            .map_err(|e| e.to_string())?;
        Ok(changed as u32)
    }

    pub fn move_messages(
        &self,
        message_ids: &[String],
        dest_folder_id: &str,
        uid_pairs: &[(u32, u32)],
    ) -> Result<(), String> {
        let mut conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let mut dropped = false;
        for id in message_ids {
            let source_uid: u32 = tx
                .query_row("SELECT uid FROM messages WHERE id = ?1", params![id], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            let dest_uid = uid_pairs
                .iter()
                .find(|p| p.0 == source_uid)
                .map(|p| p.1)
                .filter(|uid| *uid > 0);
            match dest_uid {
                Some(dest_uid) => {
                    tx.execute(
                        "UPDATE messages SET folder_id = ?1, uid = ?3 WHERE id = ?2",
                        params![dest_folder_id, id, dest_uid],
                    )
                    .map_err(|e| e.to_string())?;
                }
                // Moved, but the server named no destination UID (no UIDPLUS):
                // the source UID must not be reused there, so the row goes and
                // the destination's next sync brings the message back.
                None => {
                    delete_message_rows(&tx, id)?;
                    dropped = true;
                }
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        if dropped {
            self.prune_blobs_locked(&conn)?;
        }
        Ok(())
    }

    /// Drop messages from the index for good — the row, its cached body, its
    /// attachment rows, and every blob no other message still names.
    ///
    /// The counterpart of `move_messages` for a delete the server has already
    /// carried out, and it is deliberately the *second* half of that pair: the
    /// caller expunges first and calls this once the server agreed, so a refused
    /// delete never leaves the index missing mail that is still in the mailbox.
    ///
    /// **Not `VACUUM`ed**, unlike `delete_account_mail`. A `DELETE` only moves
    /// pages to the freelist, where a plain store's subject stays readable — but
    /// that is `forget_message_content`'s standing trade too, and rewriting a
    /// multi-gigabyte database to delete one mail would make the ordinary case
    /// unusable. A sealed store has nothing readable there to begin with.
    pub fn delete_messages(&self, message_ids: &[String]) -> Result<u32, String> {
        let mut conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let mut removed = 0u32;
        for id in message_ids {
            removed += delete_message_rows(&tx, id)?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        self.prune_blobs_locked(&conn)?;
        Ok(removed)
    }

    // ── Bodies ──────────────────────────────────────────────────────────────

    /// A cached sanitized body, **only** when it was produced by the current
    /// sanitizer version. A sanitizer fix therefore re-protects already-synced
    /// mail rather than leaving old output in place.
    #[allow(clippy::type_complexity)]
    pub fn cached_body(
        &self,
        message_id: &str,
        version: u32,
    ) -> Result<Option<(Option<String>, Option<String>, String, u32, bool)>, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let row = conn
            .query_row(
                "SELECT html, text, links_json, remote_refs, truncated
                 FROM bodies_cache WHERE message_id = ?1 AND version = ?2",
                params![message_id, version],
                |r| {
                    let t = "bodies_cache";
                    Ok((
                        self.open_opt_text(r, 0, "", t, "html", message_id)?,
                        self.open_opt_text(r, 1, "", t, "text", message_id)?,
                        self.open_text(r, 2, "", t, "links_json", message_id)?,
                        r.get::<_, u32>(3)?,
                        r.get::<_, i64>(4)? != 0,
                    ))
                },
            )
            .optional()
            .map_err(|e| e.to_string())?;

        // A cached body that will not open is treated as a **cache miss**, not
        // as an error: the caller re-fetches it from the server and re-seals it.
        // That is the right degrade here and nowhere else — a body is derived
        // data with an authoritative copy upstream, which a subject line in the
        // index is not.
        Ok(match row {
            Some((html, text, links, refs, truncated)) => match (html, text, links) {
                (Some(None), _, _) | (_, Some(None), _) | (_, _, None) => None,
                (html, text, Some(links)) => {
                    Some((html.flatten(), text.flatten(), links, refs, truncated))
                }
            },
            None => None,
        })
    }

    pub fn cache_body(
        &self,
        message_id: &str,
        version: u32,
        html: Option<&str>,
        text: Option<&str>,
        links_json: &str,
        remote_refs: u32,
        truncated: bool,
        raw_blob: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        conn.execute(
            "INSERT INTO bodies_cache
                (message_id, version, html, text, links_json, remote_refs, truncated, raw_blob)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
             ON CONFLICT(message_id) DO UPDATE SET
                version = excluded.version, html = excluded.html, text = excluded.text,
                links_json = excluded.links_json, remote_refs = excluded.remote_refs,
                truncated = excluded.truncated, raw_blob = excluded.raw_blob",
            params![
                message_id,
                version,
                self.seal_opt_text("", "bodies_cache", "html", message_id, html),
                self.seal_opt_text("", "bodies_cache", "text", message_id, text),
                self.seal_text("", "bodies_cache", "links_json", message_id, links_json),
                remote_refs,
                truncated as i64,
                raw_blob
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    // ── Attachments ─────────────────────────────────────────────────────────

    pub fn put_attachment(
        &self,
        message_id: &str,
        meta: &MailAttachmentMeta,
        blob: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        conn.execute(
            "INSERT INTO attachments (message_id, part_id, filename, mime, size, inline, mismatch, blob)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
             ON CONFLICT(message_id, part_id) DO UPDATE SET
                filename = excluded.filename, mime = excluded.mime, size = excluded.size,
                inline = excluded.inline, mismatch = excluded.mismatch, blob = excluded.blob",
            params![
                message_id,
                meta.part_id,
                self.seal_attachment(message_id, &meta.part_id, "filename", &meta.filename),
                self.seal_attachment(message_id, &meta.part_id, "mime", &meta.mime),
                meta.size as i64,
                meta.inline as i64,
                self.seal_opt_attachment(
                    message_id,
                    &meta.part_id,
                    "mismatch",
                    meta.type_mismatch.as_deref()
                ),
                blob
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// The AAD row key for `attachments`, whose primary key is composite.
    ///
    /// NUL-joined for the reason [`mail_crypt::field_aad`] gives: a separator
    /// that can occur inside either half is one that lets two different rows
    /// produce one AAD, which is exactly the relocation the binding exists to
    /// stop.
    fn attachment_row(message_id: &str, part_id: &str) -> String {
        format!("{message_id}\u{0}{part_id}")
    }

    fn seal_attachment(
        &self,
        message_id: &str,
        part_id: &str,
        column: &str,
        value: &str,
    ) -> SqlValue {
        self.seal_text(
            "",
            "attachments",
            column,
            &Self::attachment_row(message_id, part_id),
            value,
        )
    }

    fn seal_opt_attachment(
        &self,
        message_id: &str,
        part_id: &str,
        column: &str,
        value: Option<&str>,
    ) -> SqlValue {
        self.seal_opt_text(
            "",
            "attachments",
            column,
            &Self::attachment_row(message_id, part_id),
            value,
        )
    }

    fn row_to_attachment(
        &self,
        r: &Row<'_>,
        message_id: &str,
    ) -> rusqlite::Result<MailAttachmentMeta> {
        let part_id: String = r.get(0)?;
        let row = Self::attachment_row(message_id, &part_id);
        let t = "attachments";
        Ok(MailAttachmentMeta {
            filename: self
                .open_text(r, 1, "", t, "filename", &row)?
                .unwrap_or_default(),
            mime: self
                .open_text(r, 2, "", t, "mime", &row)?
                .unwrap_or_default(),
            size: r.get::<_, i64>(3)? as u64,
            inline: r.get::<_, i64>(4)? != 0,
            type_mismatch: self.open_opt_text(r, 5, "", t, "mismatch", &row)?.flatten(),
            part_id,
        })
    }

    pub fn attachments(&self, message_id: &str) -> Result<Vec<MailAttachmentMeta>, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let mut stmt = conn
            .prepare(
                "SELECT part_id, filename, mime, size, inline, mismatch
                 FROM attachments WHERE message_id = ?1 ORDER BY part_id",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![message_id], |r| {
                self.row_to_attachment(r, message_id)
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    /// Drop everything cached for one message — its attachment rows, its body
    /// cache row — and every blob that leaves unreferenced.
    ///
    /// For a message that turned out to be end-to-end encrypted: a store written
    /// before `mail_body` stopped persisting decrypted attachments holds their
    /// plaintext under the at-rest key only, which is the collapse
    /// `docs/context/mail_encryption.md` forbids. Opening it again removes it.
    pub fn forget_message_content(&self, message_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        conn.execute(
            "DELETE FROM attachments WHERE message_id = ?1",
            params![message_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM bodies_cache WHERE message_id = ?1",
            params![message_id],
        )
        .map_err(|e| e.to_string())?;
        self.prune_blobs_locked(&conn)
    }

    /// Remove every blob file no `attachments.blob` or `bodies_cache.raw_blob`
    /// names. Content addressing dedupes, so a blob is only garbage once the
    /// *last* row naming it is gone — a per-row delete would break another
    /// message carrying the same PDF.
    fn prune_blobs_locked(&self, conn: &Connection) -> Result<(), String> {
        let dir = self.blobs_dir();
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return Ok(());
        };
        let mut live = std::collections::HashSet::new();
        let mut stmt = conn
            .prepare(
                "SELECT blob FROM attachments
                 UNION SELECT raw_blob FROM bodies_cache WHERE raw_blob IS NOT NULL",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for row in rows {
            live.insert(row.map_err(|e| e.to_string())?);
        }
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            // Only files shaped like a blob id: anything else in the directory
            // is not ours to delete.
            let is_blob = name.len() == 64 && name.bytes().all(|b| b.is_ascii_hexdigit());
            if is_blob && !live.contains(&name) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
        Ok(())
    }

    /// One attachment's metadata plus the blob digest holding its bytes.
    pub fn attachment(
        &self,
        message_id: &str,
        part_id: &str,
    ) -> Result<Option<(MailAttachmentMeta, String)>, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        conn.query_row(
            "SELECT part_id, filename, mime, size, inline, mismatch, blob
             FROM attachments WHERE message_id = ?1 AND part_id = ?2",
            params![message_id, part_id],
            |r| {
                Ok((
                    self.row_to_attachment(r, message_id)?,
                    r.get::<_, String>(6)?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    // ── Drafts ──────────────────────────────────────────────────────────────

    /// Atomic MCP compare-and-swap. A composer save clears origin/owner and
    /// makes a racing agent edit/delete fail instead of reclaiming the draft.
    ///
    /// Invariant: every `staged` table row of an agent draft is agent-origin.
    /// A file the user picked into it (`mail_attach_pick`, no save needed)
    /// takes the draft out of the agent's reach, like a composer save does.
    /// The draft JSON's `staged` is rewritten from the table, which is the
    /// truth a send reads; the JSON only mirrors it.
    pub fn change_agent_draft(&self, before: Option<&MailDraft>, after: Option<&MailDraft>) -> Result<(), String> {
        let draft = after.or(before).ok_or("Missing draft")?;
        {
            let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
            self.agent_draft_guard(&conn, before, after)?;
            if let Some(next) = after {
                let mut next = next.clone();
                next.staged = self.staged_rows(&conn, &next.id)?;
                self.write_agent_draft(&conn, before.is_none(), &next)?;
                return Ok(());
            }
            conn.execute("DELETE FROM drafts WHERE id = ?1", params![draft.id]).map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM staged WHERE draft_id = ?1", params![draft.id]).map_err(|e| e.to_string())?;
        }
        // An agent's delete takes its staged copies with it, as `delete_draft`
        // does for the composer's discard.
        let _ = std::fs::remove_dir_all(self.outbox_dir(&draft.id));
        Ok(())
    }

    /// An agent's write that also changes the files it staged, all under one
    /// lock: the draft compare-and-swap, the table-origin check, the sealed
    /// copies, the rows, and the draft JSON (its `staged` rewritten from the
    /// table). `remove` names agent rows only; a user row is never touched.
    /// Returns the draft's staged set after the change.
    pub fn change_draft_files(
        &self,
        before: Option<&MailDraft>,
        after: &MailDraft,
        add: Vec<NewStagedFile>,
        remove: &[String],
    ) -> Result<Vec<StagedAttachment>, String> {
        let mut conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        self.agent_draft_guard(&conn, before, Some(after))?;
        let dir = self.outbox_dir(&after.id);
        let mut written: Vec<PathBuf> = Vec::new();
        let result = (|| -> Result<Vec<StagedAttachment>, String> {
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            if !add.is_empty() {
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                harden(&dir, 0o700);
            }
            for file in &add {
                let path = dir.join(sanitize_id(&file.staged_id));
                write_store_file(&path, &self.seal_staged(&after.id, &file.staged_id, &file.bytes))?;
                written.push(path.clone());
                let row = staged_row(&after.id, &file.staged_id);
                tx.execute(
                    "INSERT INTO staged (draft_id, staged_id, filename, mime, size, origin, source)
                     VALUES (?1,?2,?3,?4,?5,'agent',?6)",
                    params![
                        after.id,
                        file.staged_id,
                        self.seal_text("", "staged", "filename", &row, &file.filename),
                        self.seal_text("", "staged", "mime", &row, &file.mime),
                        file.bytes.len() as i64,
                        self.seal_text("", "staged", "source", &row, &file.source)
                    ],
                )
                .map_err(|e| e.to_string())?;
            }
            for id in remove {
                tx.execute(
                    "DELETE FROM staged WHERE draft_id = ?1 AND staged_id = ?2 AND origin = 'agent'",
                    params![after.id, id],
                )
                .map_err(|e| e.to_string())?;
            }
            let mut next = after.clone();
            next.staged = self.staged_rows(&tx, &after.id)?;
            self.write_agent_draft(&tx, before.is_none(), &next)?;
            tx.commit().map_err(|e| e.to_string())?;
            Ok(next.staged)
        })();
        drop(conn);
        match result {
            Ok(rows) => {
                for id in remove.iter().filter(|id| !rows.iter().any(|r| &r.staged_id == *id)) {
                    let _ = std::fs::remove_file(dir.join(sanitize_id(id)));
                }
                Ok(rows)
            }
            Err(e) => {
                // Nothing staged: a copy whose row never landed is removed.
                for path in written {
                    let _ = std::fs::remove_file(path);
                }
                Err(e)
            }
        }
    }

    /// The checks every agent write makes under the store lock: the stored
    /// draft still equals `before` (a composer save in between fails the
    /// write), `after` is shaped like an agent draft, and no table row of the
    /// draft is the user's.
    fn agent_draft_guard(&self, conn: &Connection, before: Option<&MailDraft>, after: Option<&MailDraft>) -> Result<(), String> {
        let draft = after.or(before).ok_or("Missing draft")?;
        let current: Option<Option<String>> = conn.query_row(
            "SELECT account_id, json FROM drafts WHERE id = ?1", params![draft.id], |r| {
                let account: String = r.get(0)?;
                self.open_text(r, 1, &account, "drafts", "json", &draft.id)
            }).optional().map_err(|e| e.to_string())?;
        let expected = before.map(serde_json::to_value).transpose().map_err(|e| e.to_string())?;
        let current = current.map(|s| s.ok_or("Draft cannot be decrypted"))
            .transpose()?.map(|s| serde_json::from_str::<serde_json::Value>(&s)).transpose().map_err(|e| e.to_string())?;
        // Normalize older drafts through the schema before comparing defaults.
        let current = current.map(serde_json::from_value::<MailDraft>).transpose().map_err(|e| e.to_string())?
            .map(serde_json::to_value).transpose().map_err(|e| e.to_string())?;
        if current != expected { return Err("Draft changed; refresh before editing".into()); }
        if let Some(next) = after {
            if next.origin.is_none() || next.owner_session.is_none() || !next.bcc.is_empty()
                || next.staged.iter().any(|a| a.origin.as_deref() != Some("agent"))
            {
                return Err("Invalid agent draft".into());
            }
        }
        let user_rows: i64 = conn.query_row(
            "SELECT COUNT(*) FROM staged WHERE draft_id = ?1 AND origin != 'agent'",
            params![draft.id], |r| r.get(0)).map_err(|e| e.to_string())?;
        if user_rows > 0 {
            return Err("the user attached a file to this draft in the composer; it is out of the agent's reach".into());
        }
        Ok(())
    }

    fn write_agent_draft(&self, conn: &Connection, new: bool, next: &MailDraft) -> Result<(), String> {
        if new {
            let count: i64 = conn.query_row("SELECT COUNT(*) FROM drafts", [], |r| r.get(0)).map_err(|e| e.to_string())?;
            if count >= 500 { return Err("Draft storage limit reached; review existing drafts".into()); }
        }
        conn.execute("INSERT INTO drafts (id, account_id, json) VALUES (?1, ?2, ?3)
            ON CONFLICT(id) DO UPDATE SET account_id = excluded.account_id, json = excluded.json",
            params![next.id, next.account_id, self.seal_text(&next.account_id, "drafts", "json", &next.id,
                &serde_json::to_string(next).map_err(|e| e.to_string())?)]).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// A composer save: the staged list is the store's, not the caller's, read
    /// and written under one lock so a pick or an agent write cannot land
    /// between the read and the save.
    pub fn save_draft_with_staged(&self, draft: &mut MailDraft) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        draft.staged = self.staged_rows(&conn, &draft.id)?;
        Self::put_draft(self, &conn, draft)
    }

    /// What a send builds from, checked under one lock: the draft is the
    /// user's (a composer save cleared its `origin`), and its staged set is
    /// exactly `staged_ids` — the set the composer showed. The bytes are the
    /// sealed copies, read before the lock is released.
    pub fn outgoing(&self, draft_id: &str, staged_ids: &[String]) -> Result<(MailDraft, Vec<OutgoingFile>), String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let draft = self.draft_in(&conn, draft_id)?.ok_or_else(|| format!("draft '{draft_id}' not found"))?;
        if draft.origin.is_some() {
            return Err("this draft was written by an agent and has not been saved in the composer; open it there and send it from there".into());
        }
        let rows = self.staged_rows(&conn, draft_id)?;
        let mut have: Vec<&str> = rows.iter().map(|r| r.staged_id.as_str()).collect();
        let mut shown: Vec<&str> = staged_ids.iter().map(String::as_str).collect();
        have.sort_unstable();
        shown.sort_unstable();
        shown.dedup();
        if have != shown {
            return Err("the attachments changed since the composer showed them; review them and send again".into());
        }
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let bytes = self.staged_bytes(draft_id, &row.staged_id)?;
            out.push((row, bytes));
        }
        Ok((draft, out))
    }

    pub fn save_draft(&self, draft: &MailDraft) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        self.put_draft(&conn, draft)
    }

    fn put_draft(&self, conn: &Connection, draft: &MailDraft) -> Result<(), String> {
        conn.execute(
            "INSERT INTO drafts (id, account_id, json) VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET account_id = excluded.account_id, json = excluded.json",
            params![
                draft.id,
                draft.account_id,
                // The whole draft, one envelope. A draft is the most sensitive
                // thing in the store — it is mail the user is still writing, so
                // it has not even reached a server that could be asked to
                // delete it.
                self.seal_text(
                    &draft.account_id,
                    "drafts",
                    "json",
                    &draft.id,
                    &serde_json::to_string(draft).map_err(|e| e.to_string())?
                )
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn draft(&self, draft_id: &str) -> Result<Option<MailDraft>, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        self.draft_in(&conn, draft_id)
    }

    fn draft_in(&self, conn: &Connection, draft_id: &str) -> Result<Option<MailDraft>, String> {
        let json: Option<Option<String>> = conn
            .query_row(
                "SELECT account_id, json FROM drafts WHERE id = ?1",
                params![draft_id],
                |r| {
                    let account_id: String = r.get(0)?;
                    self.open_text(r, 1, &account_id, "drafts", "json", draft_id)
                },
            )
            .optional()
            .map_err(|e| e.to_string())?;
        match json {
            Some(Some(j)) => Ok(Some(serde_json::from_str(&j).map_err(|e| e.to_string())?)),
            // Unlike a cached body there is no upstream copy to re-fetch, so an
            // unreadable draft is an error the user is told about rather than a
            // silently empty compose window.
            Some(None) => Err("this draft could not be decrypted".into()),
            None => Ok(None),
        }
    }

    /// Every stored draft. Callers filter by `origin`: the mail view lists the
    /// agent-written ones, and the root MCP tools serve each caller class its
    /// own. A row that does not open or parse is skipped rather than failing the
    /// list — `draft()` is where that error is told.
    pub fn drafts(&self) -> Result<Vec<MailDraft>, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let mut stmt = conn
            .prepare("SELECT id, account_id, json FROM drafts ORDER BY rowid")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                let id: String = r.get(0)?;
                let account_id: String = r.get(1)?;
                self.open_text(r, 2, &account_id, "drafts", "json", &id)
            })
            .map_err(|e| e.to_string())?;
        Ok(rows
            .filter_map(|row| row.ok().flatten())
            .filter_map(|json| serde_json::from_str(&json).ok())
            .collect())
    }

    /// ✓ Approvals' approve on agent drafts: each goes into the "Drafted by
    /// agents" folder (`filed`). Bound to what the panel showed — a draft an
    /// agent changed since, or the user took over in the composer, is left
    /// for the panel's next look. The files an agent staged are part of that
    /// comparison, read from the table Send reads (gap 34); files the user
    /// picked into it are not: they are the user's own. Returns how many were
    /// filed; an error names how many changed under the panel.
    ///
    /// The draft JSON's own `staged` is left out of the text comparison: the
    /// panel's copy carries the table's rows (`mail_agent_drafts`), the JSON a
    /// mirror that a user's pick does not rewrite, so the two differ whenever
    /// the user added a file.
    pub fn file_agent_drafts(&self, shown: &[MailDraft]) -> Result<usize, String> {
        fn seen(d: &MailDraft) -> Result<serde_json::Value, String> {
            let mut d = d.clone();
            d.staged.clear();
            serde_json::to_value(d).map_err(|e| e.to_string())
        }
        /// An agent's rows, in a stable order, as the comparison sees them.
        fn agent_rows(rows: &[StagedAttachment]) -> Vec<(&str, &str, &str, u64, Option<&str>)> {
            let mut out: Vec<_> = rows
                .iter()
                .filter(|r| r.origin.as_deref() == Some("agent"))
                .map(|r| (r.staged_id.as_str(), r.filename.as_str(), r.mime.as_str(), r.size, r.source.as_deref()))
                .collect();
            out.sort_unstable();
            out
        }
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let (mut filed, mut changed) = (0, 0);
        for draft in shown {
            let current = self.draft_in(&conn, &draft.id)?;
            let rows = match &current {
                Some(_) => self.staged_rows(&conn, &draft.id)?,
                None => Vec::new(),
            };
            match current {
                Some(mut current)
                    if current.origin.is_some()
                        && seen(&current)? == seen(draft)?
                        && agent_rows(&rows) == agent_rows(&draft.staged) =>
                {
                    if !current.filed {
                        current.filed = true;
                        self.put_draft(&conn, &current)?;
                    }
                    filed += 1;
                }
                _ => changed += 1,
            }
        }
        if changed > 0 {
            return Err(format!("{changed} draft(s) changed since they were shown; look again before approving"));
        }
        Ok(filed)
    }

    pub fn delete_draft(&self, draft_id: &str) -> Result<(), String> {
        {
            let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
            conn.execute("DELETE FROM drafts WHERE id = ?1", params![draft_id])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM staged WHERE draft_id = ?1", params![draft_id])
                .map_err(|e| e.to_string())?;
        }
        let _ = std::fs::remove_dir_all(self.outbox_dir(draft_id));
        Ok(())
    }

    // ── Staged (outgoing) attachments ───────────────────────────────────────

    /// Copy `bytes` into the draft's staging directory under an opaque id.
    ///
    /// The *copy* is the boundary: after this call the mail subsystem has no
    /// reason and no verb to read the original file again, and a compose window
    /// cannot re-read it later.
    pub fn stage_attachment(
        &self,
        draft_id: &str,
        staged_id: &str,
        filename: &str,
        mime: &str,
        bytes: &[u8],
    ) -> Result<StagedAttachment, String> {
        // Under `conn` from the file write on, so the payload and the row are
        // sealed under the same keys of the moment (see `put_blob`).
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let dir = self.outbox_dir(draft_id);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        harden(&dir, 0o700);
        let path = dir.join(sanitize_id(staged_id));
        // Sealed like everything else, and for a reason the plan calls the
        // classic hole: `outbox/` is where a file the user picked lands in the
        // clear, outside the database, for as long as the draft exists. It is
        // consumed in memory by `build_outgoing` and never handed back as a
        // path.
        write_store_file(&path, &self.seal_staged(draft_id, staged_id, bytes))?;

        let staged = StagedAttachment {
            staged_id: staged_id.to_string(),
            filename: filename.to_string(),
            mime: mime.to_string(),
            size: bytes.len() as u64,
            origin: None,
            source: None,
        };
        // The user's pick: `origin` stays `''`, which is what takes an agent
        // draft out of the agent's reach (`agent_draft_guard`).
        conn.execute(
            "INSERT INTO staged (draft_id, staged_id, filename, mime, size, origin, source)
             VALUES (?1,?2,?3,?4,?5,'','')
             ON CONFLICT(draft_id, staged_id) DO UPDATE SET
                filename = excluded.filename, mime = excluded.mime, size = excluded.size,
                origin = '', source = ''",
            params![
                draft_id,
                staged.staged_id,
                self.seal_text(
                    "",
                    "staged",
                    "filename",
                    &staged_row(draft_id, staged_id),
                    &staged.filename
                ),
                self.seal_text(
                    "",
                    "staged",
                    "mime",
                    &staged_row(draft_id, staged_id),
                    &staged.mime
                ),
                staged.size as i64
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(staged)
    }

    /// The AAD for a staged payload file. Built from the **sanitized** ids so it
    /// names exactly the file on disk — the same two strings that form the path.
    fn staged_aad(draft_id: &str, staged_id: &str) -> Vec<u8> {
        mail_crypt::staged_aad(&sanitize_id(draft_id), &sanitize_id(staged_id))
    }

    fn seal_staged(&self, draft_id: &str, staged_id: &str, bytes: &[u8]) -> Vec<u8> {
        match self.keys().as_deref() {
            Some(k) => mail_crypt::seal(&k.blob, &Self::staged_aad(draft_id, staged_id), bytes),
            None => bytes.to_vec(),
        }
    }

    pub fn staged(&self, draft_id: &str) -> Result<Vec<StagedAttachment>, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        self.staged_rows(&conn, draft_id)
    }

    fn staged_rows(&self, conn: &Connection, draft_id: &str) -> Result<Vec<StagedAttachment>, String> {
        let mut stmt = conn
            .prepare(
                "SELECT staged_id, filename, mime, size, origin, source FROM staged
                 WHERE draft_id = ?1 ORDER BY staged_id",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![draft_id], |r| {
                let staged_id: String = r.get(0)?;
                let row = staged_row(draft_id, &staged_id);
                let origin: String = r.get(4)?;
                let source = self.open_text(r, 5, "", "staged", "source", &row)?.unwrap_or_default();
                Ok(StagedAttachment {
                    filename: self
                        .open_text(r, 1, "", "staged", "filename", &row)?
                        .unwrap_or_default(),
                    mime: self
                        .open_text(r, 2, "", "staged", "mime", &row)?
                        .unwrap_or_default(),
                    size: r.get::<_, i64>(3)? as u64,
                    staged_id,
                    origin: Some(origin).filter(|o| !o.is_empty()),
                    source: Some(source).filter(|s| !s.is_empty()),
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn staged_bytes(&self, draft_id: &str, staged_id: &str) -> Result<Vec<u8>, String> {
        let path = self.outbox_dir(draft_id).join(sanitize_id(staged_id));
        let raw = std::fs::read(&path).map_err(|e| e.to_string())?;
        match self.keys().as_deref() {
            Some(k) => k
                .open_any(|k| &k.blob, &Self::staged_aad(draft_id, staged_id), &raw)
                .map(|(p, _)| p.to_vec())
                .map_err(|e| e.to_string()),
            None => Ok(raw),
        }
    }

    pub fn remove_staged(&self, draft_id: &str, staged_id: &str) -> Result<(), String> {
        {
            let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
            conn.execute(
                "DELETE FROM staged WHERE draft_id = ?1 AND staged_id = ?2",
                params![draft_id, staged_id],
            )
            .map_err(|e| e.to_string())?;
        }
        let _ = std::fs::remove_file(self.outbox_dir(draft_id).join(sanitize_id(staged_id)));
        Ok(())
    }

    // ── Housekeeping ────────────────────────────────────────────────────────

    /// Drop cached bodies, attachment rows and every blob, keeping folders and
    /// the header index. A mail store grows without bound and the user needs
    /// one button, not a shell.
    pub fn clear_cached_mail(&self) -> Result<(), String> {
        {
            let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
            conn.execute_batch("DELETE FROM bodies_cache; DELETE FROM attachments;")
                .map_err(|e| e.to_string())?;
        }
        let _ = std::fs::remove_dir_all(self.blobs_dir());
        Ok(())
    }

    // ── Migrating an existing cleartext store ───────────────────────────────

    /// Seal everything in this store that is still cleartext. Returns whether
    /// anything actually changed.
    ///
    /// **Idempotent, and that is what makes it restartable.** Every value is
    /// examined individually and skipped if it is already an envelope, so being
    /// killed half-way through leaves a store in a mixed state that the next
    /// open simply finishes — there is no stage counter to get out of step with
    /// what is on disk. (SQLite's dynamic typing is what allows the mixed state:
    /// a `TEXT` and a `BLOB` coexist in one column.)
    ///
    /// The honest limitation, which the UI states rather than this file hiding:
    /// **the plaintext that was here does not reliably go away.** `VACUUM INTO`
    /// a fresh file plus deleting the old one is the best a userspace program
    /// can do, and on an SSD or a copy-on-write filesystem it is not erasure.
    /// Anyone who actually cares should use "delete local mail and re-sync"
    /// instead, which never writes the plaintext in the first place.
    fn seal_existing(&self) -> Result<bool, String> {
        if !self.is_encrypted() {
            return Ok(false);
        }
        {
            let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
            let done: Option<String> = conn
                .query_row(
                    "SELECT value FROM meta WHERE key = ?1",
                    params![META_ENCRYPTED],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if done.as_deref() == Some("1") {
                return Ok(false);
            }
        }

        let mut changed = 0usize;
        for (table, pk, account_col, columns) in SEALED_TABLES {
            changed += self.seal_table(table, pk, *account_col, columns)?;
            if *table == "messages" {
                // `reply_key` is a digest of a `Message-ID`, and in a store that
                // ran plain it *is* that id. There is no sealed copy to
                // re-digest it from, so it is dropped; the next sync writes
                // every row's keyed one back.
                let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
                changed += conn
                    .execute("UPDATE messages SET reply_key = '' WHERE reply_key != ''", [])
                    .map_err(|e| e.to_string())?;
            }
        }
        changed += self.reseal_blobs()?;
        changed += self.reseal_outbox()?;
        // Not marked done here. The flag is what makes the next open skip this
        // pass — and with it the vacuum — so setting it before the vacuum had
        // run meant a crash or a full disk in between left the old plaintext in
        // the freelist for good. `open_with_keys` marks it once the vacuum is in.
        Ok(changed > 0)
    }

    fn marked_encrypted(&self) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        conn.query_row(
            "SELECT value FROM meta WHERE key = ?1",
            params![META_ENCRYPTED],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map(|v| v.as_deref() == Some("1"))
        .map_err(|e| e.to_string())
    }

    /// Columns that were sealed on write but missing from `seal_existing`'s list
    /// when a store was first migrated. That pass never runs again once a store
    /// is marked, so these get their own one-time pass, recorded under its own
    /// meta key.
    fn seal_late_columns(&mut self) -> Result<(), String> {
        const LATE: &str = "sealed_priority_columns";
        {
            let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
            let done: Option<String> = conn
                .query_row("SELECT value FROM meta WHERE key = ?1", params![LATE], |r| {
                    r.get(0)
                })
                .optional()
                .map_err(|e| e.to_string())?;
            if done.as_deref() == Some("1") {
                return Ok(());
            }
        }
        let changed = self.seal_table(
            "messages",
            &["id"],
            Some("account_id"),
            &["priority_source", "priority_reason"],
        )?;
        if changed > 0 {
            self.vacuum_into_place()?;
        }
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, '1')",
            params![LATE],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Record that sealing (and the vacuum after it) finished.
    fn mark_encrypted(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, '1')",
            params![META_ENCRYPTED],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Seal every still-cleartext value in `columns` of `table`.
    ///
    /// The AAD's row key is the primary-key columns NUL-joined, which is exactly
    /// how the read and write paths build theirs — one definition, so a value
    /// sealed by the migration opens through the ordinary getter.
    fn seal_table(
        &self,
        table: &'static str,
        pk: &'static [&'static str],
        account_col: Option<&'static str>,
        columns: &'static [&'static str],
    ) -> Result<usize, String> {
        if !self.is_encrypted() {
            return Ok(0);
        }
        let mut conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;

        // (row key, account id, [(column, plaintext)])
        type Pending = (Vec<String>, String, Vec<(&'static str, String)>);
        let pending: Vec<Pending> = {
            let select: Vec<&str> = pk
                .iter()
                .chain(account_col.iter())
                .chain(columns.iter())
                .copied()
                .collect();
            let mut stmt = conn
                .prepare(&format!("SELECT {} FROM {table}", select.join(", ")))
                .map_err(|e| e.to_string())?;
            let value_base = pk.len() + usize::from(account_col.is_some());
            let rows = stmt
                .query_map([], |r| {
                    use rusqlite::types::ValueRef;
                    let mut key = Vec::with_capacity(pk.len());
                    for i in 0..pk.len() {
                        key.push(r.get::<_, String>(i)?);
                    }
                    let account = match account_col {
                        Some(_) => r.get::<_, String>(pk.len())?,
                        None => String::new(),
                    };
                    let mut todo = Vec::new();
                    for (n, column) in columns.iter().enumerate() {
                        // A `Blob` is already an envelope and a `Null` has
                        // nothing to seal. Only `Text` is work.
                        if let ValueRef::Text(t) = r.get_ref(value_base + n)? {
                            todo.push((*column, String::from_utf8_lossy(t).into_owned()));
                        }
                    }
                    Ok((key, account, todo))
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
                .into_iter()
                .filter(|(_, _, todo)| !todo.is_empty())
                .collect()
        };
        if pending.is_empty() {
            return Ok(0);
        }

        let where_clause = pk
            .iter()
            .map(|c| format!("{c} = ?"))
            .collect::<Vec<_>>()
            .join(" AND ");
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let mut changed = 0usize;
        for (key, account, todo) in &pending {
            let row_key = key.join("\u{0}");
            for (column, plaintext) in todo {
                let sealed = self.seal_text(account, table, column, &row_key, plaintext);
                let mut args: Vec<SqlValue> = vec![sealed];
                args.extend(key.iter().map(|k| SqlValue::Text(k.clone())));
                tx.execute(
                    &format!("UPDATE {table} SET {column} = ? WHERE {where_clause}"),
                    params_from_iter(args),
                )
                .map_err(|e| e.to_string())?;
                changed += 1;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(changed)
    }

    /// Bring the two keyed digest columns back in step with the current keys.
    ///
    /// `folders.path_key` and `mail_remote_allow.addr_key` are digests of a
    /// value that may since have been sealed, and [`MailStore::seal_existing`]
    /// seals values without touching the keys beside them — so a store that ran
    /// plain and was converted later kept digests that are the **cleartext**
    /// value. Two things go wrong with that. The loud one: `upsert_folder`'s
    /// conflict target stops matching, so every sync tried to insert a folder
    /// that is already there and failed on its primary key
    /// (*"UNIQUE constraint failed: folders.id"*). The quiet one is worse — the
    /// stale key *is* the folder path, sitting in cleartext in a store whose
    /// whole claim is that only a keyed digest of it does.
    ///
    /// It runs on every keyed open, not only after a conversion, because it is
    /// also the repair for stores a build without it already converted. The
    /// cost is one pass over a table holding one row per folder — tens, not
    /// thousands. A row whose value will not open is **skipped**: rekeying it
    /// would mean writing a digest of nothing over the only key that still
    /// finds it.
    fn rekey_digest_columns(&self) -> Result<usize, String> {
        if !self.is_encrypted() {
            return Ok(0);
        }
        let mut conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;

        // (id, account_id, stored path_key, plaintext path)
        let folders: Vec<(String, String, String, Option<String>)> = {
            let mut stmt = conn
                .prepare("SELECT id, account_id, path_key, path FROM folders")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| {
                    let id: String = r.get(0)?;
                    let account_id: String = r.get(1)?;
                    let path_key: String = r.get(2)?;
                    // The path's AAD names its row by `id`, which no rekeying
                    // touches — so a sealed path opens here exactly as it does
                    // on the read path.
                    let path = self.open_text(r, 3, &account_id, "folders", "path", &id)?;
                    Ok((id, account_id, path_key, path))
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        // (stored addr_key, plaintext address)
        let allowed: Vec<(String, Option<String>)> = {
            let mut stmt = conn
                .prepare("SELECT addr_key, address FROM mail_remote_allow")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| {
                    let addr_key: String = r.get(0)?;
                    let address =
                        self.open_text(r, 1, "", "mail_remote_allow", "address", &addr_key)?;
                    Ok((addr_key, address))
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };

        // (message_id, stored mid_key, the opened header). The header is
        // opened row by row under the lock already held — `header()` would take
        // it a second time. The whole header, not only its `Message-ID`: the
        // key folds in the sender too (`agent_mark_key`).
        let marks: Vec<(String, String, Option<MailHeader>)> = {
            let mut stmt = conn
                .prepare("SELECT message_id, mid_key FROM agent_marks")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?;
            let keys = rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
            let mut out = Vec::with_capacity(keys.len());
            for (message_id, mid_key) in keys {
                let header: Option<MailHeader> = conn
                    .query_row(
                        &format!("SELECT {} FROM messages WHERE id = ?1", Self::HEADER_COLUMNS),
                        params![message_id],
                        |r| self.row_to_header(r),
                    )
                    .optional()
                    .map_err(|e| e.to_string())?;
                out.push((message_id, mid_key, header));
            }
            out
        };

        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let mut changed = 0usize;
        for (message_id, mid_key, header) in &marks {
            // A mark whose message is not in the index, or whose row will not
            // open, gets an empty key rather than keeping the old one: in a
            // plain store that key IS the cleartext `Message-ID`, and nothing
            // in the clear may survive a sealing. The primary key still finds
            // the row; only the follow-on onto a re-indexed copy is lost.
            let expected = header
                .as_ref()
                .map(|h| self.agent_mark_key(h))
                .unwrap_or_default();
            if &expected == mid_key {
                continue;
            }
            if tx
                .execute(
                    "UPDATE agent_marks SET mid_key = ?1 WHERE message_id = ?2",
                    params![expected, message_id],
                )
                .is_ok()
            {
                changed += 1;
            }
        }
        for (id, account_id, path_key, path) in &folders {
            let Some(path) = path else { continue };
            let expected = self.digest_of(account_id, path);
            if &expected == path_key {
                continue;
            }
            // Two rows cannot legitimately want one key — the digest is of the
            // same (account, path) the row's own id was derived from — but a
            // duplicate left behind by some earlier state would make the
            // `UNIQUE` fire, and a repair that refuses to open the store would
            // be worse than the fault it repairs. The row is left alone; the
            // second conflict clause in `upsert_folder` still keeps the sync
            // working.
            if tx
                .execute(
                    "UPDATE folders SET path_key = ?1 WHERE id = ?2",
                    params![expected, id],
                )
                .is_ok()
            {
                changed += 1;
            }
        }
        for (addr_key, address) in &allowed {
            let Some(address) = address else { continue };
            let expected = self.digest_of("mail_remote_allow", address);
            if &expected == addr_key {
                continue;
            }
            // Here the key column *is* the row key the value's AAD names, so
            // moving it means re-sealing the value under the new one — in one
            // statement, or an interruption between the two would leave a row
            // nothing can ever open.
            let sealed = self.seal_text("", "mail_remote_allow", "address", &expected, address);
            if tx
                .execute(
                    "UPDATE mail_remote_allow SET addr_key = ?1, address = ?2 WHERE addr_key = ?3",
                    params![expected, sealed, addr_key],
                )
                .is_ok()
            {
                changed += 1;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(changed)
    }

    /// Seal every blob payload and move it from its bare SHA-256 name onto its
    /// keyed one, rewriting the two cleartext columns that reference it.
    fn reseal_blobs(&self) -> Result<usize, String> {
        let Some(keys) = self.keys() else {
            return Ok(0);
        };
        let dir = self.blobs_dir();
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return Ok(0);
        };
        let mut changed = 0usize;
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Some(old_id) = path.file_name().and_then(|n| n.to_str()).map(str::to_owned) else {
                continue;
            };
            let Ok(bytes) = std::fs::read(&path) else {
                continue;
            };
            // Sealed means "opens under this key and its own name", not "starts
            // with the envelope magic": an attachment crafted to begin with
            // `ELMC\x01` would otherwise stay plaintext under its bare SHA-256
            // name — exactly the confirmation oracle the keyed names remove.
            if mail_crypt::looks_sealed(&bytes)
                && mail_crypt::open(&keys.blob, &mail_crypt::blob_aad(&old_id), &bytes).is_ok()
            {
                continue;
            }
            let new_id = mail_crypt::blob_id(&keys.addr, &bytes);
            let sealed = mail_crypt::seal(&keys.blob, &mail_crypt::blob_aad(&new_id), &bytes);
            let new_path = dir.join(&new_id);
            write_store_file(&new_path, &sealed)?;
            if new_id != old_id {
                let _ = std::fs::remove_file(&path);
                let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
                conn.execute(
                    "UPDATE bodies_cache SET raw_blob = ?1 WHERE raw_blob = ?2",
                    params![new_id, old_id],
                )
                .map_err(|e| e.to_string())?;
                conn.execute(
                    "UPDATE attachments SET blob = ?1 WHERE blob = ?2",
                    params![new_id, old_id],
                )
                .map_err(|e| e.to_string())?;
            }
            changed += 1;
        }
        Ok(changed)
    }

    /// Seal every staged (outgoing) payload in place. Their names are already
    /// opaque ids, so unlike a blob nothing has to be renamed.
    fn reseal_outbox(&self) -> Result<usize, String> {
        if !self.is_encrypted() {
            return Ok(0);
        }
        let root = self.dir.join("outbox");
        let Ok(drafts) = std::fs::read_dir(&root) else {
            return Ok(0);
        };
        let mut changed = 0usize;
        for draft in drafts.flatten() {
            let Some(draft_id) = draft.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let Ok(files) = std::fs::read_dir(draft.path()) else {
                continue;
            };
            for file in files.flatten() {
                let path = file.path();
                let Some(staged_id) = path.file_name().and_then(|n| n.to_str()).map(str::to_owned)
                else {
                    continue;
                };
                let Ok(bytes) = std::fs::read(&path) else {
                    continue;
                };
                if mail_crypt::looks_sealed(&bytes) {
                    continue;
                }
                write_store_file(&path, &self.seal_staged(&draft_id, &staged_id, &bytes))?;
                changed += 1;
            }
        }
        Ok(changed)
    }

    /// Rewrite the database into a fresh file and swap it in.
    ///
    /// The step that makes the migration worth doing. Sealing values with
    /// `UPDATE` leaves every old plaintext in the WAL and in the freelist —
    /// pages SQLite has stopped referencing but has not overwritten — so a store
    /// "migrated" in place still has the cleartext subject lines in it, readable
    /// with a hex editor. `VACUUM INTO` writes a new file containing only live
    /// pages, and the old one is then removed.
    fn vacuum_into_place(&mut self) -> Result<(), String> {
        let db = self.dir.join("mail.db");
        let target = self.dir.join("mail.db.sealed");
        let _ = std::fs::remove_file(&target);
        {
            let conn = self.conn.get_mut().map_err(|_| "mail store is poisoned")?;
            conn.execute("VACUUM INTO ?1", params![target.to_string_lossy()])
                .map_err(|e| format!("could not rewrite the mail store: {e}"))?;
        }
        // Close the old connection *before* touching the files. An open handle
        // owns a `-wal`/`-shm` pair, and leaving them beside a replaced database
        // would hand the new file a journal belonging to the old one.
        {
            let placeholder = Connection::open_in_memory().map_err(|e| e.to_string())?;
            let old = std::mem::replace(
                self.conn.get_mut().map_err(|_| "mail store is poisoned")?,
                placeholder,
            );
            drop(old);
        }
        let _ = std::fs::remove_file(self.dir.join("mail.db-wal"));
        let _ = std::fs::remove_file(self.dir.join("mail.db-shm"));
        std::fs::rename(&target, &db).map_err(|e| e.to_string())?;
        harden(&db, 0o600);
        let conn = Connection::open(&db).map_err(|e| e.to_string())?;
        configure(&conn);
        *self.conn.get_mut().map_err(|_| "mail store is poisoned")? = conn;
        Ok(())
    }

    // ── Re-keying (hosted plan §6.8, user decision 2026-10-03) ─────────────
    //
    // Revoking a device on a server rotates the secrets key, and the rotation
    // gives this store a fresh master key (`mail_crypt::rotate_device_key_file`):
    // from the switch on every write is sealed under it, while the keys keep
    // the old masters for reading. These steps move what is already here,
    // batch by batch, each under `conn` and each its own transaction with its
    // progress marker; between batches mail works as usual. Once a pass ends
    // with nothing left under an old master the caller retires them.

    /// One batch of the re-key. `Done` when the store holds no previous
    /// master or nothing is left to move.
    pub fn rekey_step(&self) -> Result<RekeyStep, String> {
        self.rekey_step_inner(None)
    }

    /// [`MailStore::rekey_step`], stopping at `crash` (tests).
    pub fn rekey_step_inner(&self, crash: Option<RekeyCrash>) -> Result<RekeyStep, String> {
        // The digests, each table, the blob files, the outbox.
        let stages = SEALED_TABLES.len() + 3;
        let mut conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        // Read under `conn`: a switch cannot slip between this and the writes.
        let Some(keys) = self.keys() else { return Ok(RekeyStep::Done) };
        if !keys.rekeying() || self.is_ephemeral() {
            return Ok(RekeyStep::Done);
        }
        // While re-keying, pages SQLite frees (a re-sealed value of another
        // size, a row deleted since the revoke) are zeroed, not left holding
        // the old master's ciphertext; `rekey_clear` turns it off again.
        conn.pragma_update(None, "secure_delete", "ON").map_err(|e| e.to_string())?;
        let target = keys.fingerprint();
        let mut cursor = Self::rekey_cursor(&conn)?.filter(|c| c.target == target).unwrap_or(RekeyCursor { target, ..Default::default() });
        // Old blob files a committed batch no longer names: gone at once
        // normally, here when a crash came in between.
        for name in std::mem::take(&mut cursor.unlink) {
            if name.len() == 64 && name.bytes().all(|b| b.is_ascii_hexdigit()) {
                let _ = std::fs::remove_file(self.blobs_dir().join(name));
            }
        }
        if cursor.stage >= stages {
            // Before the old master is retired: the WAL's frames from before
            // the pass are the last copies of its ciphertext in the database
            // files. A checkpoint that truncates the log drops them (this
            // connection is the store's only one, so nothing holds it back).
            Self::truncate_wal(&conn);
            return Ok(RekeyStep::Done);
        }

        if cursor.stage == 0 {
            // The keyed digests first (a few rows: folders, the remote-content
            // list, agent marks): lookups by digest then find their rows under
            // the new key for the rest of the pass.
            drop(conn);
            let changed = self.rekey_digest_columns()?;
            let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
            cursor.stage = 1;
            cursor.after = 0;
            Self::save_rekey_cursor(&conn, &cursor)?;
            return Ok(RekeyStep::More { seen: 0, moved: changed });
        }

        if cursor.stage <= SEALED_TABLES.len() {
            let (table, pk, account_col, columns) = SEALED_TABLES[cursor.stage - 1];
            // (rowid, row key, account, [(column, sealed)])
            type Row = (i64, String, String, Vec<(&'static str, Vec<u8>)>);
            let rows: Vec<Row> = {
                let select: Vec<&str> = ["rowid"].iter().chain(pk.iter()).chain(account_col.iter()).chain(columns.iter()).copied().collect();
                let mut stmt = conn
                    .prepare(&format!("SELECT {} FROM {table} WHERE rowid > ?1 ORDER BY rowid LIMIT ?2", select.join(", ")))
                    .map_err(|e| e.to_string())?;
                let value_base = 1 + pk.len() + usize::from(account_col.is_some());
                let rows = stmt
                    .query_map(params![cursor.after, REKEY_ROWS as i64], |r| {
                        use rusqlite::types::ValueRef;
                        let rowid: i64 = r.get(0)?;
                        let mut key = Vec::with_capacity(pk.len());
                        for i in 0..pk.len() {
                            key.push(r.get::<_, String>(1 + i)?);
                        }
                        let account = match account_col {
                            Some(_) => r.get::<_, String>(1 + pk.len())?,
                            None => String::new(),
                        };
                        let mut sealed = Vec::new();
                        for (n, column) in columns.iter().enumerate() {
                            // Only a `Blob` is an envelope; `Null` and the
                            // `Text` column defaults hold nothing sealed.
                            if let ValueRef::Blob(b) = r.get_ref(value_base + n)? {
                                sealed.push((*column, b.to_vec()));
                            }
                        }
                        Ok((rowid, key.join("\u{0}"), account, sealed))
                    })
                    .map_err(|e| e.to_string())?;
                rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
            };
            let mut updates: Vec<(i64, &'static str, Vec<u8>)> = Vec::new();
            // `Message-ID`s of the batch's messages: the replies naming one
            // carry its digest under a previous key in `reply_key`.
            let mut reply_ids: Vec<String> = Vec::new();
            let (mut seen, mut bytes, mut last) = (0usize, 0usize, cursor.after);
            for (rowid, row_key, account, sealed) in &rows {
                for (column, value) in sealed {
                    let aad = mail_crypt::field_aad(account, table, column, row_key);
                    let opened = keys.open_any(|k| &k.field, &aad, value);
                    if table == "messages" && *column == "rfc_message_id" {
                        if let Ok((plain, _)) = &opened {
                            let id = normalize_rfc_id(&String::from_utf8_lossy(plain)).to_string();
                            if !id.is_empty() {
                                reply_ids.push(id);
                            }
                        }
                    }
                    // Already under the current master: nothing to do. Under
                    // none (damaged on disk): left alone, it reads as damaged
                    // either way.
                    if let Ok((plain, false)) = opened {
                        bytes += plain.len();
                        updates.push((*rowid, column, mail_crypt::seal(&keys.field, &aad, &plain)));
                    }
                }
                seen += 1;
                last = *rowid;
                if bytes >= REKEY_BYTES {
                    break;
                }
            }
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            for (rowid, column, value) in &updates {
                tx.execute(&format!("UPDATE {table} SET {column} = ?1 WHERE rowid = ?2"), params![value, rowid])
                    .map_err(|e| e.to_string())?;
            }
            // The replies to these messages: their `reply_key` is a digest
            // under the key it was written with, so after the switch the
            // replies strip found none of the earlier ones, and the old-key
            // digests stayed for the old master to match. Moved to the
            // current key through the `messages_by_reply_key` index.
            for id in &reply_ids {
                let new = mail_crypt::name_digest(&keys.name, "reply", id);
                for old in keys.previous() {
                    tx.execute(
                        "UPDATE messages SET reply_key = ?1 WHERE reply_key = ?2",
                        params![new, mail_crypt::name_digest(&old.name, "reply", id)],
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
            if rows.len() < REKEY_ROWS && seen == rows.len() {
                cursor.stage += 1;
                cursor.after = 0;
            } else {
                cursor.after = last;
            }
            Self::save_rekey_cursor(&tx, &cursor)?;
            tx.commit().map_err(|e| e.to_string())?;
            return Ok(RekeyStep::More { seen, moved: updates.len() });
        }

        if cursor.stage == SEALED_TABLES.len() + 1 {
            return self.rekey_blobs(conn, &keys, cursor, crash);
        }

        // The outbox: a draft's picked files, few and renamed by nobody.
        let mut moved = 0usize;
        let root = self.dir.join("outbox");
        if let Ok(drafts) = std::fs::read_dir(&root) {
            for draft in drafts.flatten() {
                let Some(draft_id) = draft.file_name().to_str().map(str::to_owned) else { continue };
                let Ok(files) = std::fs::read_dir(draft.path()) else { continue };
                for file in files.flatten() {
                    let path = file.path();
                    let Some(staged_id) = path.file_name().and_then(|n| n.to_str()).map(str::to_owned) else { continue };
                    // A staged id is sanitized to `[A-Za-z0-9_-]`: a name with a
                    // dot is a temp file of an interrupted write, not a payload.
                    if staged_id.contains('.') {
                        continue;
                    }
                    let Ok(raw) = std::fs::read(&path) else { continue };
                    let aad = Self::staged_aad(&draft_id, &staged_id);
                    if let Ok((plain, false)) = keys.open_any(|k| &k.blob, &aad, &raw) {
                        mail_crypt::write_bytes_atomic(&path, &mail_crypt::seal(&keys.blob, &aad, &plain))?;
                        moved += 1;
                    }
                }
            }
        }
        cursor.stage += 1;
        Self::save_rekey_cursor(&conn, &cursor)?;
        Ok(RekeyStep::More { seen: moved, moved })
    }

    /// One batch of blob files: each opened under a previous master is
    /// re-sealed under the current one, under its new keyed name (the name
    /// is a digest under the store's key too), then the rows naming it are
    /// pointed at the new name, then the old file goes. A crash before the
    /// commit leaves an unreferenced new file beside the still-named old one
    /// (the resumed batch adopts it); one after it, an old file the marker
    /// names for deletion — never a reference to nothing.
    fn rekey_blobs(&self, mut conn: std::sync::MutexGuard<'_, Connection>, keys: &MailKeys, mut cursor: RekeyCursor, crash: Option<RekeyCrash>) -> Result<RekeyStep, String> {
        let dir = self.blobs_dir();
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .map(|entries| {
                entries
                    .flatten()
                    .filter_map(|e| e.file_name().to_str().map(str::to_owned))
                    .filter(|n| n.len() == 64 && n.bytes().all(|b| b.is_ascii_hexdigit()) && *n > cursor.blob_after)
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        let (mut seen, mut bytes) = (0usize, 0usize);
        let mut moves: Vec<(String, String)> = Vec::new();
        // Each moved file's bytes, for the one that turns out unreferenced.
        let mut plains: Vec<zeroize::Zeroizing<Vec<u8>>> = Vec::new();
        for name in &names {
            seen += 1;
            cursor.blob_after = name.clone();
            let Ok(raw) = std::fs::read(dir.join(name)) else { continue };
            bytes += raw.len();
            if let Ok((plain, false)) = keys.open_any(|k| &k.blob, &mail_crypt::blob_aad(name), &raw) {
                let new_id = mail_crypt::blob_id(&keys.addr, &plain);
                let new_path = dir.join(&new_id);
                let new_aad = mail_crypt::blob_aad(&new_id);
                // The new name may exist already: the same bytes arrived again
                // since the switch (`put_blob`, which writes without a sync), or
                // a batch a crash cut short wrote it. Adopted only if it opens
                // under the current key, and synced first — the old file goes
                // once the rows point here, so this copy must be on disk.
                let adoptable = std::fs::read(&new_path).is_ok_and(|b| mail_crypt::open(&keys.blob, &new_aad, &b).is_ok());
                if adoptable {
                    // Opened for writing: `FlushFileBuffers` on Windows needs it.
                    std::fs::OpenOptions::new().read(true).write(true).open(&new_path).and_then(|f| f.sync_all()).map_err(|e| e.to_string())?;
                } else {
                    mail_crypt::write_bytes_atomic(&new_path, &mail_crypt::seal(&keys.blob, &new_aad, &plain))?;
                }
                moves.push((name.clone(), new_id));
                plains.push(plain);
            }
            if seen >= REKEY_ROWS || bytes >= REKEY_BYTES {
                break;
            }
        }
        if crash == Some(RekeyCrash::BlobsWritten) {
            return Err(REKEY_CRASHED.into());
        }
        if !moves.is_empty() {
            // The adopted files' names, too (`write_bytes_atomic` synced its own).
            if let Ok(handle) = std::fs::File::open(&dir) {
                let _ = handle.sync_all();
            }
        }
        let finished = seen == names.len();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        if !moves.is_empty() {
            // One pass over each table for the whole batch. Neither column is
            // indexed, and `raw_blob` sits behind the bodies, so a statement
            // per moved file was a full read of the body cache per file — up
            // to 400 of them while holding the store's lock.
            tx.execute_batch("CREATE TEMP TABLE IF NOT EXISTS rekey_moves (old TEXT PRIMARY KEY, new TEXT NOT NULL); DELETE FROM rekey_moves;")
                .map_err(|e| e.to_string())?;
            for (old, new) in &moves {
                tx.execute("INSERT OR REPLACE INTO rekey_moves (old, new) VALUES (?1, ?2)", params![old, new]).map_err(|e| e.to_string())?;
            }
            // A file no row names yet may still be named under its old name:
            // `put_blob` wrote it under the old keys just before the switch,
            // and the row naming it lands after this batch. Re-sealed in place
            // under the current key instead of moved, so that late row finds
            // a file — one the old master no longer opens. (Its new-name copy
            // stays for the prune; a `put_blob` of the same bytes may name it.)
            let referenced: std::collections::HashSet<String> = {
                let mut stmt = tx
                    .prepare(
                        "SELECT old FROM rekey_moves
                         WHERE old IN (SELECT raw_blob FROM bodies_cache WHERE raw_blob IS NOT NULL)
                            OR old IN (SELECT blob FROM attachments)",
                    )
                    .map_err(|e| e.to_string())?;
                let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
                rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
            };
            for ((old, _), plain) in moves.iter().zip(&plains) {
                if !referenced.contains(old) {
                    mail_crypt::write_bytes_atomic(&dir.join(old), &mail_crypt::seal(&keys.blob, &mail_crypt::blob_aad(old), plain))?;
                }
            }
            moves.retain(|(old, _)| referenced.contains(old));
            tx.execute(
                "UPDATE bodies_cache SET raw_blob = (SELECT new FROM rekey_moves WHERE old = bodies_cache.raw_blob)
                 WHERE raw_blob IN (SELECT old FROM rekey_moves)",
                [],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "UPDATE attachments SET blob = (SELECT new FROM rekey_moves WHERE old = attachments.blob)
                 WHERE blob IN (SELECT old FROM rekey_moves)",
                [],
            )
            .map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM rekey_moves", []).map_err(|e| e.to_string())?;
        }
        if finished {
            cursor.stage += 1;
        }
        cursor.unlink = moves.iter().filter(|(old, new)| old != new).map(|(old, _)| old.clone()).collect();
        Self::save_rekey_cursor(&tx, &cursor)?;
        // Durable before any old file goes (WAL, `synchronous` FULL).
        tx.commit().map_err(|e| e.to_string())?;
        if crash == Some(RekeyCrash::BlobsCommitted) {
            return Err(REKEY_CRASHED.into());
        }
        for old in &cursor.unlink {
            let _ = std::fs::remove_file(dir.join(old));
        }
        Ok(RekeyStep::More { seen, moved: moves.len() })
    }

    fn rekey_cursor(conn: &Connection) -> Result<Option<RekeyCursor>, String> {
        let raw: Option<String> = conn
            .query_row("SELECT value FROM meta WHERE key = ?1", params![META_REKEY], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        // An unreadable marker is a pass from the start, not an error.
        Ok(raw.and_then(|raw| serde_json::from_str(&raw).ok()))
    }

    fn save_rekey_cursor(conn: &Connection, cursor: &RekeyCursor) -> Result<(), String> {
        let json = serde_json::to_string(cursor).map_err(|e| e.to_string())?;
        conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)", params![META_REKEY, json])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Forget a finished re-key's marker (after the old masters are retired).
    pub fn rekey_clear(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        conn.execute("DELETE FROM meta WHERE key = ?1", params![META_REKEY]).map_err(|e| e.to_string())?;
        let _ = conn.pragma_update(None, "secure_delete", "OFF");
        Ok(())
    }

    /// `PRAGMA wal_checkpoint(TRUNCATE)`, best effort: a busy answer is
    /// logged (the frames are then dropped by a later checkpoint).
    fn truncate_wal(conn: &Connection) {
        match conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| r.get::<_, i64>(0)) {
            Ok(0) => {}
            Ok(_) => eprintln!("mail: the re-key's WAL checkpoint was busy; old frames go at a later checkpoint"),
            Err(e) => eprintln!("mail: the re-key's WAL checkpoint failed: {e}"),
        }
    }

    /// How far the re-key towards the current master is: `(done, total)`,
    /// in rows and blob files, from the marker. For the progress line only.
    pub fn rekey_progress(&self) -> Result<(u64, u64), String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        let target = self.keys().map(|k| k.fingerprint()).unwrap_or_default();
        let cursor = Self::rekey_cursor(&conn)?.filter(|c| c.target == target).unwrap_or_default();
        let count = |sql: &str, after: Option<i64>| -> Result<u64, String> {
            match after {
                Some(after) => conn.query_row(sql, params![after], |r| r.get::<_, i64>(0)),
                None => conn.query_row(sql, [], |r| r.get::<_, i64>(0)),
            }
            .map(|n| n.max(0) as u64)
            .map_err(|e| e.to_string())
        };
        let (mut done, mut total) = (0u64, 0u64);
        for (i, (table, ..)) in SEALED_TABLES.iter().enumerate() {
            let rows = count(&format!("SELECT COUNT(*) FROM {table}"), None)?;
            total += rows;
            let stage = i + 1;
            if cursor.stage > stage {
                done += rows;
            } else if cursor.stage == stage {
                done += count(&format!("SELECT COUNT(*) FROM {table} WHERE rowid <= ?1"), Some(cursor.after))?;
            }
        }
        let blobs: Vec<String> = std::fs::read_dir(self.blobs_dir())
            .map(|entries| entries.flatten().filter_map(|e| e.file_name().to_str().map(str::to_owned)).filter(|n| n.len() == 64).collect())
            .unwrap_or_default();
        total += blobs.len() as u64;
        if cursor.stage > SEALED_TABLES.len() + 1 {
            done += blobs.len() as u64;
        } else if cursor.stage == SEALED_TABLES.len() + 1 {
            done += blobs.iter().filter(|n| **n <= cursor.blob_after).count() as u64;
        }
        Ok((done.min(total), total))
    }

    /// Remove everything belonging to one account, blobs included.
    pub fn delete_account_mail(&self, account_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "mail store is poisoned")?;
        conn.execute(
            "DELETE FROM bodies_cache WHERE message_id IN
                (SELECT id FROM messages WHERE account_id = ?1)",
            params![account_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM attachments WHERE message_id IN
                (SELECT id FROM messages WHERE account_id = ?1)",
            params![account_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM agent_marks WHERE account_id = ?1",
            params![account_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM messages WHERE account_id = ?1",
            params![account_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM folders WHERE account_id = ?1",
            params![account_id],
        )
        .map_err(|e| e.to_string())?;
        // "Blobs included", which the doc comment always promised: the rows
        // naming them are gone, so the files would otherwise outlive the account.
        self.prune_blobs_locked(&conn)?;
        // And the rows themselves: a `DELETE` only moves pages to the freelist,
        // where a plain store's subjects and bodies stay readable in `mail.db`.
        // Drafts are deliberately kept — they are unsent work, not cached mail,
        // and the confirmation only promises the latter.
        conn.execute_batch("VACUUM").map_err(|e| e.to_string())
    }
}

/// The token appended to a message's `malformed_headers` when one of its sealed
/// columns would not open.
///
/// It shares the malformed channel because the UI already has a banner for it
/// and because that is honestly what the row is: structurally present, partly
/// unreadable. The alternative — rendering an un-openable subject as an empty
/// one — would let anyone with disk write access blank a message's identity and
/// have it look like ordinary mail, which is the whole reason the AAD binding
/// exists.
pub const MALFORMED_SEALED: &str = "sealed-value";

impl MailStore {
    fn row_to_header(&self, r: &Row<'_>) -> rusqlite::Result<MailHeader> {
        let id: String = r.get(0)?;
        let account_id: String = r.get(1)?;
        let t = "messages";

        // One flag for the whole row: a message with an unreadable subject and
        // an unreadable preview is one damaged message, not two problems.
        let mut damaged = false;
        let mut sealed = |idx: usize, column: &str| -> rusqlite::Result<String> {
            match self.open_text(r, idx, &account_id, t, column, &id)? {
                Some(v) => Ok(v),
                None => {
                    damaged = true;
                    Ok(String::new())
                }
            }
        };

        let subject = sealed(4, "subject")?;
        let from_json = sealed(5, "from_json")?;
        let to_json = sealed(6, "to_json")?;
        let cc_json = sealed(7, "cc_json")?;
        let preview = sealed(14, "preview")?;
        let malformed = sealed(15, "malformed")?;
        let rfc_message_id = sealed(16, "rfc_message_id")?;
        let authres_json = sealed(17, "authres_json")?;
        // `unwrap_or_default` because a caller whose SELECT predates the column
        // gets no mark rather than a panic. Cleartext — it is what the two
        // priority lists filter on.
        let priority: String = r.get(18).unwrap_or_default();
        // Provenance (#205). Sealed like the other value columns, so it goes
        // through the same `sealed` closure that flags a damaged row. A SELECT
        // predating the columns simply yields empty — no mark, no reason.
        let priority_source = sealed(19, "priority_source").unwrap_or_default();
        let priority_reason = sealed(20, "priority_reason").unwrap_or_default();

        let mut malformed_headers: Vec<String> = if malformed.is_empty() {
            Vec::new()
        } else {
            malformed.split(',').map(|s| s.to_string()).collect()
        };
        if damaged {
            malformed_headers.push(MALFORMED_SEALED.to_string());
        }

        Ok(MailHeader {
            id,
            account_id,
            folder_id: r.get(2)?,
            uid: r.get(3)?,
            subject,
            from: serde_json::from_str(&from_json).unwrap_or_default(),
            to: serde_json::from_str(&to_json).unwrap_or_default(),
            cc: serde_json::from_str(&cc_json).unwrap_or_default(),
            date: r.get(8)?,
            seen: r.get::<_, i64>(9)? != 0,
            flagged: r.get::<_, i64>(10)? != 0,
            answered: r.get::<_, i64>(11)? != 0,
            has_attachments: r.get::<_, i64>(12)? != 0,
            size: r.get::<_, i64>(13)? as u64,
            preview,
            malformed_headers: (!malformed_headers.is_empty()).then_some(malformed_headers),
            rfc_message_id: (!rfc_message_id.is_empty()).then_some(rfc_message_id),
            // Deserialized in whatever state it was stored in — always
            // `Unconfigured`. `commands::mail` applies the account's trusted id
            // before this ever reaches the frontend; a row that somehow escaped
            // that step therefore shows no verdict rather than an unchecked one.
            auth: if authres_json.is_empty() {
                None
            } else {
                serde_json::from_str(&authres_json).unwrap_or(None)
            },
            // An unrecognized value reads as unmarked; see `MailPriority::parse`.
            priority: MailPriority::parse(&priority),
            // Provenance rides the mark: a cleared mark clears both, so these are
            // only ever `Some` on a marked message.
            priority_source: MailPrioritySource::parse(&priority_source),
            priority_reason: (!priority_reason.is_empty()).then_some(priority_reason),
        })
    }
}

/// Write a payload file into the store's own folders (`blobs/`, `outbox/`),
/// owner-only from its first byte: created with mode `0600` on Unix (and an
/// existing file narrowed before the new bytes go in), so it is never
/// world-readable for the moment a write-then-chmod would leave. On Windows
/// it inherits the store folder's owner-only ACL
/// ([`mail_crypt::harden_store_dir`]), with no `icacls` run per file. Not
/// synced, as the plain `fs::write` it replaces was not.
fn write_store_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write as _;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // The mode above applies to a file this call creates; one that was
        // already there (a re-seal in place) is narrowed here. Best effort,
        // like `harden`.
        let _ = file.set_permissions(std::fs::Permissions::from_mode(0o600));
    }
    file.write_all(bytes).map_err(|e| e.to_string())
}

/// The pragmas every connection to this store runs with.
///
/// `temp_store = MEMORY` is the one that belongs to the encryption work: it was
/// simply unset, which means SQLite was free to spill a sort or a large join
/// into a temp *file* — plaintext, in whatever `/tmp` the process happened to
/// have, entirely outside the sealed store. Every other defence here is about
/// what lands in `mail.db`, and none of them cover a scratch file.
fn configure(conn: &Connection) {
    conn.pragma_update(None, "journal_mode", "WAL").ok();
    conn.pragma_update(None, "foreign_keys", "ON").ok();
    conn.pragma_update(None, "temp_store", "MEMORY").ok();
}

/// One message's row, cached body, attachment rows and agent marks; the
/// caller prunes the blobs once its transaction committed.
fn delete_message_rows(conn: &Connection, id: &str) -> Result<u32, String> {
    conn.execute("DELETE FROM attachments WHERE message_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM bodies_cache WHERE message_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    // The consent went with the message; a later row under a reused
    // id must not inherit it.
    conn.execute("DELETE FROM agent_marks WHERE message_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(conn
        .execute("DELETE FROM messages WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())? as u32)
}

/// The AAD row key for `staged`, whose primary key is composite. NUL-joined,
/// matching [`MailStore::seal_table`]'s generic construction so a value sealed
/// by the migration opens through the ordinary getter.
fn staged_row(draft_id: &str, staged_id: &str) -> String {
    format!("{draft_id}\u{0}{staged_id}")
}

/// Reduce an identifier to something that cannot name anything but a leaf
/// inside the store. Ids are minted by the backend, so this is a belt: the
/// braces are that nothing outside `mail_dir()` is ever joined onto.
/// A `Message-ID` as both sides of the reply lookup spell it: `mail-parser`
/// hands ids back bare, a composed `In-Reply-To` may carry its angle brackets.
fn normalize_rfc_id(id: &str) -> &str {
    id.trim().trim_start_matches('<').trim_end_matches('>').trim()
}

fn sanitize_id(id: &str) -> String {
    let cleaned: String = id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(128)
        .collect();
    if cleaned.is_empty() {
        "unnamed".to_string()
    } else {
        cleaned
    }
}


/// Whether `table` has a column named `column`. A table that does not exist
/// has none.
fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)",
        params![table, column],
        |r| r.get::<_, bool>(0),
    )
    .map_err(|e| format!("inspect {table}.{column}: {e}"))
}

/// Add `column` (declared `decl`) to `table` unless it is already there — the
/// additive half of [`MailStore::migrate`]. Only "already there" is skipped:
/// a missing table, a read-only or locked database, a bad declaration come
/// back as errors instead of a store that silently keeps its old shape.
///
/// `table`, `column` and `decl` are literals from `migrate`, never input: an
/// identifier cannot be a bound parameter.
fn add_column_if_missing(conn: &Connection, table: &str, column: &str, decl: &str) -> Result<(), String> {
    if column_exists(conn, table, column)? {
        return Ok(());
    }
    conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"), [])
        .map(|_| ())
        .map_err(|e| format!("add column {table}.{column}: {e}"))
}

#[cfg(test)]
mod tests;

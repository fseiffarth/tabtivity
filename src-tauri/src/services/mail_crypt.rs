//! At-rest encryption for the local mail store (`docs/mail_encryption_plan.md`
//! Phase 1).
//!
//! This module is the *primitive* and the *key*, and nothing else — it knows
//! nothing about SQLite, folders or messages. `mail_store` is the only caller
//! that seals anything, which is what keeps the envelope shape reviewable in one
//! place.
//!
//! # Three decisions carry the whole design
//!
//! **1. Values are sealed, the database file is not.** Whole-file encryption
//! (SQLCipher and friends) is out on the no-OpenSSL invariant, but it would be
//! the wrong shape anyway: because every *value* is already an envelope by the
//! time SQLite sees it, the WAL and the freelist can only ever contain
//! ciphertext. There is no window in which SQLite writes plaintext to disk. The
//! single exception is migrating a store that was created before this existed,
//! which is why that migration ends in `VACUUM INTO` a new file rather than an
//! in-place rewrite.
//!
//! **2. XChaCha20-Poly1305, with a random nonce.** The 192-bit nonce is the
//! reason. AES-GCM's 96-bit nonce is too small to draw at random, so it needs a
//! counter — a counter that must survive both a crash and a restore-from-backup,
//! and *that* is how nonce reuse actually happens in the field. A restored
//! backup here re-derives nothing and reuses nothing. The `alg` byte in the
//! envelope keeps AES-GCM a swap rather than a rewrite if a hardware-AES
//! argument ever wins.
//!
//! **3. Every ciphertext is bound to its row identity by AAD.** This is the part
//! at-rest encryption is famous for leaving open. Without it, an attacker with
//! disk *write* access — a synced backup directory, a shared machine — copies
//! message A's sealed body onto message B's row and the client renders it as B.
//! No key required, no tag broken; the tag is still valid, it is just valid for
//! the wrong row. Binding `account_id ‖ table ‖ column ‖ row_key` into the AAD
//! makes that relocation a decryption failure. It costs one string
//! concatenation. [`tests::a_sealed_value_cannot_be_relocated_to_another_row`]
//! is the assertion that it still holds.
//!
//! # What this does not defend
//!
//! A live process with the store unlocked; an attacker who can run code as the
//! user; memory scraping. Full-disk encryption already covers the stolen-laptop
//! case for most users — the marginal value here is backups, copies, sync
//! services and multi-user machines, where FDE is not in play. The UI says so
//! rather than implying more.

use std::path::{Path, PathBuf};

use base64::Engine as _;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::XChaCha20Poly1305;
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::services::remote_credentials;

// ── The envelope ────────────────────────────────────────────────────────────

/// `[ b"ELMC" | u8 version | u8 alg | [u8; 24] nonce | ciphertext‖tag ]`
const MAGIC: &[u8; 4] = b"ELMC";

/// Bumped only for a change to the envelope *layout*. An algorithm swap is the
/// `alg` byte's job, not this one.
pub const ENVELOPE_VERSION: u8 = 1;

/// XChaCha20-Poly1305. The only algorithm this version produces.
pub const ALG_XCHACHA20_POLY1305: u8 = 1;

const NONCE_LEN: usize = 24;
const TAG_LEN: usize = 16;
const HEADER_LEN: usize = MAGIC.len() + 2 + NONCE_LEN;

/// How much longer a sealed value is than its plaintext.
pub const OVERHEAD: usize = HEADER_LEN + TAG_LEN;

/// A 32-byte symmetric key. Zeroized on drop, and it does not print itself —
/// the `Debug` impl is deliberate, because a key that lands in a log line is a
/// key on disk in a file nobody thinks of as a key store.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct Key([u8; 32]);

impl Key {
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Key(bytes)
    }

    /// Draw a fresh key from the OS RNG.
    pub fn random() -> Result<Self, String> {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(|e| format!("no system randomness: {e}"))?;
        Ok(Key(bytes))
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl std::fmt::Debug for Key {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Key(<redacted>)")
    }
}

/// Why an `open` failed.
///
/// Deliberately coarse on the authenticity side: a caller cannot tell a wrong
/// key from a wrong AAD from a flipped bit, because all three mean the same
/// thing operationally ("these bytes are not what was sealed here") and a finer
/// distinction is an oracle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CryptError {
    /// Too short, or the magic is not ours. Distinguishable from
    /// [`CryptError::NotAuthentic`] on purpose — it is how the migration tells a
    /// still-plaintext value from a sealed one, and it says nothing about a key.
    NotAnEnvelope,
    UnsupportedVersion(u8),
    UnsupportedAlgorithm(u8),
    NotAuthentic,
}

impl std::fmt::Display for CryptError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CryptError::NotAnEnvelope => f.write_str("not a sealed value"),
            CryptError::UnsupportedVersion(v) => {
                write!(f, "sealed by a newer version of {app} (envelope v{v})", app = crate::brand::DISPLAY)
            }
            CryptError::UnsupportedAlgorithm(a) => {
                write!(
                    f,
                    "sealed with an algorithm this build does not have (alg {a})"
                )
            }
            CryptError::NotAuthentic => f.write_str("could not decrypt (wrong key, or altered)"),
        }
    }
}

impl std::error::Error for CryptError {}

/// Seal `plaintext` under `key`, authenticating `aad` alongside it.
///
/// Infallible in practice: the only failure the AEAD can report is a plaintext
/// longer than 256 GiB, which no mail value reaches, and a nonce draw that fails
/// means the OS RNG is gone. Both panic rather than returning, because a
/// silently-unsealed write is the one outcome worse than a crash — it would put
/// plaintext in the column this function exists to protect.
pub fn seal(key: &Key, aad: &[u8], plaintext: &[u8]) -> Vec<u8> {
    let mut nonce = [0u8; NONCE_LEN];
    getrandom::fill(&mut nonce).expect("the OS RNG must be available to seal mail");

    let cipher = XChaCha20Poly1305::new(key.as_bytes().into());
    let ciphertext = cipher
        .encrypt(
            (&nonce).into(),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .expect("XChaCha20-Poly1305 only fails on an impossibly long message");

    let mut out = Vec::with_capacity(HEADER_LEN + ciphertext.len());
    out.extend_from_slice(MAGIC);
    out.push(ENVELOPE_VERSION);
    out.push(ALG_XCHACHA20_POLY1305);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);
    out
}

/// Open a sealed value. The plaintext comes back in a [`Zeroizing`] so a caller
/// that drops it does not leave it in a freed allocation.
pub fn open(key: &Key, aad: &[u8], sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, CryptError> {
    if sealed.len() < HEADER_LEN + TAG_LEN || &sealed[..4] != MAGIC {
        return Err(CryptError::NotAnEnvelope);
    }
    let version = sealed[4];
    if version != ENVELOPE_VERSION {
        return Err(CryptError::UnsupportedVersion(version));
    }
    let alg = sealed[5];
    if alg != ALG_XCHACHA20_POLY1305 {
        return Err(CryptError::UnsupportedAlgorithm(alg));
    }
    let nonce: [u8; NONCE_LEN] = sealed[6..HEADER_LEN]
        .try_into()
        .map_err(|_| CryptError::NotAnEnvelope)?;

    let cipher = XChaCha20Poly1305::new(key.as_bytes().into());
    cipher
        .decrypt(
            (&nonce).into(),
            Payload {
                msg: &sealed[HEADER_LEN..],
                aad,
            },
        )
        .map(Zeroizing::new)
        .map_err(|_| CryptError::NotAuthentic)
}

/// Whether `bytes` carry this module's envelope header.
///
/// The migration's only question: a column holding a plaintext subject and a
/// column holding a sealed one are both `BLOB`-or-`TEXT` to SQLite, and this is
/// what tells them apart without a key. A plaintext value that happened to start
/// with `ELMC` and a plausible version byte would be misread — so the migration
/// never trusts this alone, it re-seals anything that fails to `open`.
pub fn looks_sealed(bytes: &[u8]) -> bool {
    bytes.len() >= HEADER_LEN + TAG_LEN && &bytes[..4] == MAGIC && bytes[4] == ENVELOPE_VERSION
}

// ── AAD construction ────────────────────────────────────────────────────────

/// The AAD for one SQLite field: `account_id ‖ 0x00 ‖ table ‖ 0x00 ‖ column ‖
/// 0x00 ‖ row_key`.
///
/// `0x00` separators rather than a delimiter that can appear in the data: with
/// `:` as the separator, an `account_id` of `a:messages` and a table of `subject`
/// would produce the same AAD as an account `a` with table `messages` and column
/// `subject`. Ids here are backend-minted and could not actually collide, but a
/// separator whose safety rests on "the inputs happen not to contain it" is one
/// refactor from being wrong, and NUL cannot appear in any of these.
pub fn field_aad(account_id: &str, table: &str, column: &str, row_key: &str) -> Vec<u8> {
    let mut aad =
        Vec::with_capacity(account_id.len() + table.len() + column.len() + row_key.len() + 3);
    aad.extend_from_slice(account_id.as_bytes());
    aad.push(0);
    aad.extend_from_slice(table.as_bytes());
    aad.push(0);
    aad.extend_from_slice(column.as_bytes());
    aad.push(0);
    aad.extend_from_slice(row_key.as_bytes());
    aad
}

/// The AAD for a blob file: `blob:<id>`. The id is already a keyed digest of the
/// content, so this binds the file to its own name.
pub fn blob_aad(id: &str) -> Vec<u8> {
    format!("blob:{id}").into_bytes()
}

/// The AAD for one staged (outgoing) attachment's payload file.
pub fn staged_aad(draft_id: &str, staged_id: &str) -> Vec<u8> {
    format!("staged:{draft_id}:{staged_id}").into_bytes()
}

/// The AAD for `accounts.json.enc`. Whole file, one envelope.
pub fn accounts_aad() -> Vec<u8> {
    b"file:accounts.json".to_vec()
}

/// The AAD for `filters.json.enc`. A **distinct** string from
/// [`accounts_aad`] — the two files are sealed under the same key, so without
/// per-file AAD an attacker with disk write access could swap one for the other
/// and have it decrypt cleanly. That is the same relocation attack the field AAD
/// exists to stop, one level up.
///
/// The rule list is sealed at all because it is exactly the kind of thing the
/// sealed store is for: the words someone watches their mail for say what they
/// are dealing with (a lawyer's name, a diagnosis, a company they are about to
/// leave) as plainly as a subject line does.
pub fn filters_aad() -> Vec<u8> {
    b"file:filters.json".to_vec()
}

/// The AAD for `contacts.json.enc` — distinct again, for [`filters_aad`]'s
/// reason. The address book is who the user writes to, which is sealed store
/// material if anything is.
pub fn contacts_aad() -> Vec<u8> {
    b"file:contacts.json".to_vec()
}

// ── Keyed digests ───────────────────────────────────────────────────────────

type HmacSha256 = Hmac<Sha256>;

fn hmac_hex(key: &Key, parts: &[&[u8]]) -> String {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(key.as_bytes())
        .expect("HMAC-SHA256 accepts any key length");
    for (i, part) in parts.iter().enumerate() {
        if i > 0 {
            mac.update(&[0]);
        }
        mac.update(part);
    }
    let out = mac.finalize().into_bytes();
    let mut hex = String::with_capacity(out.len() * 2);
    for b in out {
        use std::fmt::Write as _;
        let _ = write!(hex, "{b:02x}");
    }
    hex
}

/// The filename a blob is stored under: `HMAC-SHA256(k_addr, plaintext)`, hex.
///
/// Replaces the bare `SHA-256(plaintext)` the store used before, which did two
/// bad things at once. It **leaked content**: anyone with a directory listing
/// could hash a file they suspected you had received and look for its name — a
/// confirmation oracle needing no key at all. And it would have **broken dedupe**
/// the moment the payloads were sealed, because two seals of identical bytes
/// differ (random nonce), so a digest of the *ciphertext* is never stable. Keying
/// the digest of the *plaintext* fixes both: the name is stable for identical
/// content and meaningless without `k_addr`.
///
/// Still 64 hex characters, so `get_blob`'s existing validation is unchanged —
/// it now means something different.
pub fn blob_id(k_addr: &Key, plaintext: &[u8]) -> String {
    hmac_hex(k_addr, &[plaintext])
}

/// A cleartext, keyed stand-in for a sealed column that carries a `UNIQUE`.
///
/// Randomized AEAD destroys uniqueness — two seals of the same folder path are
/// two different values, so `UNIQUE (account_id, path)` would stop deduplicating
/// and every sync would insert the folder again. The fix is one keyed digest per
/// identity, held in a new cleartext column that carries the constraint, with the
/// readable value sealed beside it. It leaks equality and only equality, which is
/// exactly what the schema already asserts by declaring the constraint at all.
pub fn name_digest(k_name: &Key, namespace: &str, value: &str) -> String {
    hmac_hex(k_name, &[namespace.as_bytes(), value.as_bytes()])
}

// ── The key hierarchy ───────────────────────────────────────────────────────

/// The strings a store's keys are derived with: the root of the HKDF labels
/// and the associated data of the wrapped master key. They are **key
/// inputs** — a store written under one set opens under no other — and they
/// carry the app's name, so a store remembers which set it was written with
/// (`labels` in `key.json`) instead of following whatever the app is called.
///
/// A store with no `labels` entry was written by a build that knew only one
/// set: the one under the app's old name. It keeps opening under that set and
/// nothing in it is touched. A store created by this build is written under
/// the current set. While the name is unchanged the two are the same set and
/// no entry is ever written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LabelSet {
    root: String,
    wrap_aad: String,
}

impl LabelSet {
    /// The set a build named `forms` writes.
    pub fn of(forms: &crate::brand::Forms) -> Self {
        LabelSet {
            root: forms.name(crate::brand::Name::MAIL_LABEL_ROOT),
            wrap_aad: forms.name(crate::brand::Name::MAIL_WRAP_AAD),
        }
    }

    /// The set new stores are written under.
    pub fn current(pair: &crate::brand::Pair) -> Self {
        Self::of(&pair.cur)
    }

    /// The set a key file names. No entry means the old name's set; an entry
    /// has to be one of the two sets this build knows — the file is editable
    /// by anyone who can write the mail folder, and an arbitrary string here
    /// could only ever make the store unopenable.
    fn of_key_file(pair: &crate::brand::Pair, file: &MailKeyFile) -> Result<Self, String> {
        let (current, legacy) = (Self::of(&pair.cur), Self::of(&pair.legacy));
        match file.labels.as_deref() {
            None => {
                if legacy != current {
                    crate::brand::legacy_hit("mail-labels");
                }
                Ok(legacy)
            }
            Some(root) if root == current.root => Ok(current),
            Some(root) if root == legacy.root => Ok(legacy),
            Some(_) => Err("the mail key file names a label set this build does not know".into()),
        }
    }

    /// What `key.json` records for this set: nothing for the old name's set
    /// (which is what every older build reads a missing entry as).
    fn key_file_entry(&self, pair: &crate::brand::Pair) -> Option<String> {
        (*self != Self::of(&pair.legacy)).then(|| self.root.clone())
    }

    fn label(&self, leaf: &str) -> Vec<u8> {
        format!("{}{leaf}", self.root).into_bytes()
    }
}

/// One master key, purpose-bound subkeys via HKDF-SHA256.
///
/// Compromise of one subkey does not hand over the others, and a purpose string
/// is cheaper than a second key file. The labels are versioned so a future
/// hierarchy change is a new label rather than a silent reinterpretation of the
/// same bytes.
pub struct MailKeys {
    /// Retained so the key file can be re-wrapped (switching unlock mode, or
    /// raising the Argon2 parameters) without re-encrypting the whole store.
    master: Key,
    /// The label set these keys were derived with; a re-wrap keeps it.
    /// Boxed: the keys travel by value inside [`Unlock`].
    labels: Box<LabelSet>,
    /// SQLite field values.
    pub field: Key,
    /// Blob and staged-attachment payloads.
    pub blob: Key,
    /// Blob *names* (`HMAC`, not encryption).
    pub addr: Key,
    /// The keyed digests standing in for sealed `UNIQUE` columns.
    pub name: Key,
    /// Secret key material belonging to another subsystem — the OpenPGP keyring
    /// (Phase 4) is sealed under this rather than under `field`, so the mail
    /// index and the private keys are not one compromise.
    pub wrap: Key,
}

impl std::fmt::Debug for MailKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("MailKeys(<redacted>)")
    }
}

fn subkey(hk: &Hkdf<Sha256>, label: &[u8]) -> Key {
    let mut okm = [0u8; 32];
    hk.expand(label, &mut okm)
        .expect("32 bytes is well within HKDF-SHA256's output limit");
    let key = Key::from_bytes(okm);
    okm.zeroize();
    key
}

impl MailKeys {
    /// The keys of a store written under the current label set.
    pub fn derive(master: Key) -> Self {
        Self::derive_with(master, LabelSet::current(&crate::brand::PAIR))
    }

    /// The keys of a store written under `labels`.
    pub fn derive_with(master: Key, labels: LabelSet) -> Self {
        let hk = Hkdf::<Sha256>::new(None, master.as_bytes());
        MailKeys {
            field: subkey(&hk, &labels.label("field")),
            blob: subkey(&hk, &labels.label("blob")),
            addr: subkey(&hk, &labels.label("addr")),
            name: subkey(&hk, &labels.label("name")),
            wrap: subkey(&hk, &labels.label("wrap")),
            master,
            labels: Box::new(labels),
        }
    }

    /// Whether these keys belong to a store still written under the app's
    /// old name's label set (always false while the name is unchanged).
    pub fn on_legacy_labels(&self) -> bool {
        *self.labels != LabelSet::current(&crate::brand::PAIR)
    }
}

// ── The key file ────────────────────────────────────────────────────────────

/// How the master key is unwrapped at startup.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UnlockMode {
    /// A random key-encryption key in the OS credential store. Silent — the
    /// mailbox opens with no prompt — and the default, because the alternative
    /// in practice is people not enabling encryption at all.
    Keychain,
    /// Argon2id over a passphrase the user types once per session.
    Passphrase,
}

/// Argon2id cost parameters, recorded **in the key file**.
///
/// Recorded rather than compiled in so they can be raised later without
/// stranding an existing store: a build that hardens the defaults still opens a
/// store written by the old ones, because the old ones travel with it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct KdfParams {
    /// KiB.
    pub m_cost: u32,
    pub t_cost: u32,
    pub p_cost: u32,
}

impl Default for KdfParams {
    /// 64 MiB / t=3 / p=1 — the plan's starting point, to be tuned by
    /// measurement on the slowest machine that has to unlock a mailbox.
    fn default() -> Self {
        KdfParams {
            m_cost: 64 * 1024,
            t_cost: 3,
            p_cost: 1,
        }
    }
}

/// `<mail dir>/key.json`. Holds no secret that is usable on its own: the master
/// key inside it is sealed under a KEK that lives in the keychain or in the
/// user's head.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MailKeyFile {
    pub version: u32,
    pub mode: UnlockMode,
    /// Only meaningful for [`UnlockMode::Passphrase`].
    #[serde(default)]
    pub kdf: KdfParams,
    /// Base64 Argon2 salt. Present in both modes so a mode switch never has to
    /// invent one.
    pub salt: String,
    /// Base64 of `seal(kek, <the label set's wrap AAD>, master)`.
    pub wrapped: String,
    /// The root of the label set the store is written under ([`LabelSet`]).
    /// Absent in every store an older build wrote, and in every store written
    /// while the app's name is unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub labels: Option<String>,
}

const KEY_FILE_VERSION: u32 = 1;

pub fn key_file_path(dir: &Path) -> PathBuf {
    dir.join("key.json")
}

/// Whether at-rest encryption has been turned on for this store.
pub fn is_enabled(dir: &Path) -> bool {
    key_file_path(dir).exists()
}

pub fn read_key_file(dir: &Path) -> Result<Option<MailKeyFile>, String> {
    let path = key_file_path(dir);
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice::<MailKeyFile>(&bytes)
            .map(Some)
            .map_err(|e| format!("the mail key file is unreadable: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("could not read the mail key file: {e}")),
    }
}

fn write_key_file(dir: &Path, file: &MailKeyFile) -> Result<(), String> {
    let path = key_file_path(dir);
    let json = serde_json::to_vec_pretty(file).map_err(|e| e.to_string())?;
    write_bytes_atomic(&path, &json)
}

/// Write via a sibling temp file and rename, then `0600`.
///
/// The mail store's own `write_json_atomic` analogue, kept here because this
/// module must not depend on `storage` for one function and because what it
/// writes is a key file — a half-written one is an unopenable mailbox.
pub fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    harden(&tmp, 0o600);
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    harden(path, 0o600);
    Ok(())
}

fn harden(path: &Path, mode: u32) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
    }
}

const B64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::STANDARD;

fn derive_passphrase_kek(passphrase: &str, salt: &[u8], kdf: KdfParams) -> Result<Key, String> {
    use argon2::{Algorithm, Argon2, Params, Version};
    // The parameters come from `key.json`, which anyone able to write the mail
    // directory can edit: an `m_cost` of 4 TiB is an allocation that takes the
    // app down on unlock. Bounded well above what this module writes (64 MiB,
    // 3 passes) and well below what would hurt.
    const MAX_M_COST_KIB: u32 = 1024 * 1024;
    if kdf.m_cost > MAX_M_COST_KIB || kdf.t_cost > 16 || kdf.p_cost > 8 {
        return Err(concat!("the key file asks for Argon2 parameters beyond what ", crate::app_name!(), " accepts").into());
    }
    let params = Params::new(kdf.m_cost, kdf.t_cost, kdf.p_cost, Some(32))
        .map_err(|e| format!("bad Argon2 parameters: {e}"))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = [0u8; 32];
    argon
        .hash_password_into(passphrase.as_bytes(), salt, &mut out)
        .map_err(|e| format!("could not derive the store key: {e}"))?;
    let key = Key::from_bytes(out);
    out.zeroize();
    Ok(key)
}

// ── Keychain-held KEK ───────────────────────────────────────────────────────

fn read_keychain_kek() -> Option<Key> {
    // The base64 and its decoding are KEK material like the key itself, so they
    // are zeroized rather than left in freed heap — the same discipline `Key`
    // and `Zeroizing` apply everywhere else in this module.
    let raw = Zeroizing::new(remote_credentials::get(
        &remote_credentials::mail_store_key_account(),
    )?);
    let bytes = Zeroizing::new(B64.decode(raw.trim()).ok()?);
    let arr: [u8; 32] = bytes.as_slice().try_into().ok()?;
    Some(Key::from_bytes(arr))
}

fn write_keychain_kek(kek: &Key) -> Result<(), String> {
    let encoded = Zeroizing::new(B64.encode(kek.as_bytes()));
    remote_credentials::set(&remote_credentials::mail_store_key_account(), Some(&encoded))
}

// ── Unlocking ───────────────────────────────────────────────────────────────

/// What a silent unlock attempt found.
#[derive(Debug)]
pub enum Unlock {
    /// Encryption has never been turned on for this store.
    Disabled,
    Ready(MailKeys),
    /// The store is a passphrase store and nobody has typed one yet.
    NeedsPassphrase,
    /// The key file exists but its key cannot be reached — most often a locked
    /// Secret Service collection, which reads identically to "nothing saved".
    ///
    /// **This is the failure the caller must handle by degrading to a
    /// memory-only store, not by refusing to open the mailbox.** A locked
    /// keyring blocking reads *forever* is a failure class this codebase has
    /// already been bitten by once; the bounded read in `remote_credentials`
    /// exists because of it, and it is why this is a state rather than an error.
    /// Sync still works, nothing persists, and the next run with an unlocked
    /// keyring picks up exactly where it left off.
    Unavailable(String),
}

/// Try to open the store's keys with no user interaction.
pub fn unlock(dir: &Path) -> Unlock {
    let file = match read_key_file(dir) {
        Ok(Some(f)) => f,
        Ok(None) => return Unlock::Disabled,
        Err(e) => return Unlock::Unavailable(e),
    };
    if file.version != KEY_FILE_VERSION {
        return Unlock::Unavailable(format!(
            concat!("this mailbox was encrypted by a newer version of ", crate::app_name!(), " (key file v{})"),
            file.version
        ));
    }
    match file.mode {
        UnlockMode::Passphrase => Unlock::NeedsPassphrase,
        UnlockMode::Keychain => match read_keychain_kek() {
            Some(kek) => match unwrap_master(&kek, &file) {
                Ok(keys) => Unlock::Ready(keys),
                Err(e) => Unlock::Unavailable(e),
            },
            None => Unlock::Unavailable(
                "the mail store key is not readable — the OS keyring is locked or the key was removed"
                    .into(),
            ),
        },
    }
}

fn unwrap_master(kek: &Key, file: &MailKeyFile) -> Result<MailKeys, String> {
    unwrap_master_for(&crate::brand::PAIR, kek, file)
}

fn unwrap_master_for(pair: &crate::brand::Pair, kek: &Key, file: &MailKeyFile) -> Result<MailKeys, String> {
    let labels = LabelSet::of_key_file(pair, file)?;
    let wrapped = B64
        .decode(&file.wrapped)
        .map_err(|_| "the mail key file is corrupt".to_string())?;
    let master = open(kek, labels.wrap_aad.as_bytes(), &wrapped).map_err(|_| {
        "the mail store key did not fit — wrong passphrase, or the key file belongs to another store"
            .to_string()
    })?;
    let arr: [u8; 32] = master
        .as_slice()
        .try_into()
        .map_err(|_| "the mail key file is corrupt".to_string())?;
    Ok(MailKeys::derive_with(Key::from_bytes(arr), labels))
}

/// Open a passphrase store.
pub fn unlock_with_passphrase(dir: &Path, passphrase: &str) -> Result<MailKeys, String> {
    unlock_with_passphrase_for(&crate::brand::PAIR, dir, passphrase)
}

fn unlock_with_passphrase_for(pair: &crate::brand::Pair, dir: &Path, passphrase: &str) -> Result<MailKeys, String> {
    let file = read_key_file(dir)?.ok_or_else(|| "this mailbox is not encrypted".to_string())?;
    if file.mode != UnlockMode::Passphrase {
        return Err("this mailbox does not use a passphrase".into());
    }
    let salt = B64
        .decode(&file.salt)
        .map_err(|_| "the mail key file is corrupt".to_string())?;
    let kek = derive_passphrase_kek(passphrase, &salt, file.kdf)?;
    unwrap_master_for(pair, &kek, &file)
}

// ── Enabling, and changing how it unlocks ───────────────────────────────────

fn fresh_salt() -> Result<Vec<u8>, String> {
    let mut salt = [0u8; 16];
    getrandom::fill(&mut salt).map_err(|e| format!("no system randomness: {e}"))?;
    Ok(salt.to_vec())
}

/// Turn on at-rest encryption with a **new** master key, unlocked from the OS
/// keychain.
///
/// Refuses if a key file already exists: overwriting one is destroying every
/// sealed value in the store, and nothing in this module is allowed to do that
/// by accident.
pub fn enable_with_keychain(dir: &Path) -> Result<MailKeys, String> {
    if is_enabled(dir) {
        return Err("this mailbox is already encrypted".into());
    }
    if !remote_credentials::store_readable() {
        return Err(
            "the OS keyring is locked, so the store key could not be saved — unlock it and try again"
                .into(),
        );
    }
    let master = Key::random()?;
    let kek = Key::random()?;
    write_keychain_kek(&kek)?;
    let pair = crate::brand::PAIR;
    let labels = LabelSet::current(&pair);
    let file = MailKeyFile {
        version: KEY_FILE_VERSION,
        mode: UnlockMode::Keychain,
        kdf: KdfParams::default(),
        salt: B64.encode(fresh_salt()?),
        wrapped: B64.encode(seal(&kek, labels.wrap_aad.as_bytes(), master.as_bytes())),
        labels: labels.key_file_entry(&pair),
    };
    write_key_file(dir, &file)?;
    Ok(MailKeys::derive_with(master, labels))
}

/// Turn on at-rest encryption with a **new** master key, unlocked by passphrase.
pub fn enable_with_passphrase(dir: &Path, passphrase: &str) -> Result<MailKeys, String> {
    enable_with_passphrase_for(&crate::brand::PAIR, dir, passphrase)
}

fn enable_with_passphrase_for(pair: &crate::brand::Pair, dir: &Path, passphrase: &str) -> Result<MailKeys, String> {
    if is_enabled(dir) {
        return Err("this mailbox is already encrypted".into());
    }
    if passphrase.is_empty() {
        return Err("a passphrase is required".into());
    }
    let master = Key::random()?;
    let salt = fresh_salt()?;
    let kdf = KdfParams::default();
    let kek = derive_passphrase_kek(passphrase, &salt, kdf)?;
    let labels = LabelSet::current(pair);
    let file = MailKeyFile {
        version: KEY_FILE_VERSION,
        mode: UnlockMode::Passphrase,
        kdf,
        salt: B64.encode(&salt),
        wrapped: B64.encode(seal(&kek, labels.wrap_aad.as_bytes(), master.as_bytes())),
        labels: labels.key_file_entry(pair),
    };
    write_key_file(dir, &file)?;
    Ok(MailKeys::derive_with(master, labels))
}

/// Re-wrap the **same** master key under a different unlock mode.
///
/// Nothing in the store is re-encrypted — that is the point of the wrap
/// indirection. Switching from keychain to passphrase and back is a key-file
/// rewrite, not a re-seal of a hundred thousand rows.
///
/// **Not a passphrase change.** Nothing calls this yet. Because the master key
/// survives, a copy of the old `key.json` (a backup, a synced folder) plus the
/// old passphrase still opens everything sealed after the switch. A user who
/// changes a passphrase because it leaked expects the old one to stop working,
/// so that action needs a new master key: today the only way to get a new
/// passphrase is `mail_encryption_reset`, which mints one. Wire this only to a
/// mode switch that says it keeps the key, or re-seal the store first.
pub fn rewrap(
    dir: &Path,
    keys: &MailKeys,
    mode: UnlockMode,
    passphrase: Option<&str>,
) -> Result<(), String> {
    let salt = fresh_salt()?;
    let kdf = KdfParams::default();
    let kek = match mode {
        UnlockMode::Keychain => {
            if !remote_credentials::store_readable() {
                return Err("the OS keyring is locked, so nothing was changed".into());
            }
            let kek = Key::random()?;
            write_keychain_kek(&kek)?;
            kek
        }
        UnlockMode::Passphrase => {
            let pass = passphrase
                .filter(|p| !p.is_empty())
                .ok_or("a passphrase is required")?;
            derive_passphrase_kek(pass, &salt, kdf)?
        }
    };
    let file = MailKeyFile {
        version: KEY_FILE_VERSION,
        mode,
        kdf,
        salt: B64.encode(&salt),
        // The same master key, so the same label set: what the rest of the
        // store is sealed under does not change with how it unlocks.
        wrapped: B64.encode(seal(&kek, keys.labels.wrap_aad.as_bytes(), keys.master.as_bytes())),
        labels: keys.labels.key_file_entry(&crate::brand::PAIR),
    };
    write_key_file(dir, &file)?;
    // Leaving a stale KEK behind when switching *away* from the keychain would
    // mean the mailbox still has a silent unlock path the user thinks they
    // removed. Best-effort: a locked keyring cannot be written to, and failing
    // the whole switch over it would be worse than the leftover.
    if mode == UnlockMode::Passphrase {
        let _ = remote_credentials::set(&remote_credentials::mail_store_key_account(), None);
    }
    Ok(())
}

/// Forget the key file and the keychain KEK.
///
/// **This does not decrypt anything** — every sealed value in the store becomes
/// permanently unreadable. The only caller is the "delete local mail and start
/// over" path, which removes the store in the same breath.
pub fn forget(dir: &Path) -> Result<(), String> {
    let _ = remote_credentials::set(&remote_credentials::mail_store_key_account(), None);
    match std::fs::remove_file(key_file_path(dir)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> Key {
        Key::from_bytes([7u8; 32])
    }

    #[test]
    fn a_sealed_value_round_trips() {
        let k = key();
        let aad = field_aad("acct", "messages", "subject", "row-1");
        let sealed = seal(&k, &aad, b"Quarterly numbers");
        assert_ne!(&sealed[..], b"Quarterly numbers");
        let out = open(&k, &aad, &sealed).unwrap();
        assert_eq!(out.as_slice(), b"Quarterly numbers");
    }

    #[test]
    fn the_envelope_has_the_documented_shape() {
        let sealed = seal(&key(), b"", b"x");
        assert_eq!(&sealed[..4], MAGIC);
        assert_eq!(sealed[4], ENVELOPE_VERSION);
        assert_eq!(sealed[5], ALG_XCHACHA20_POLY1305);
        assert_eq!(sealed.len(), 1 + OVERHEAD);
    }

    #[test]
    fn two_seals_of_the_same_plaintext_differ() {
        let k = key();
        assert_ne!(seal(&k, b"", b"same"), seal(&k, b"", b"same"));
    }

    /// The relocation attack the AAD exists to stop: an attacker with disk write
    /// access moves message A's sealed body onto message B's row. The tag is
    /// still valid — it is just valid for a different AAD.
    #[test]
    fn a_sealed_value_cannot_be_relocated_to_another_row() {
        let k = key();
        let a = field_aad("acct", "bodies_cache", "text", "message-a");
        let b = field_aad("acct", "bodies_cache", "text", "message-b");
        let sealed = seal(&k, &a, b"the salary review");
        assert_eq!(open(&k, &b, &sealed), Err(CryptError::NotAuthentic));
        assert!(open(&k, &a, &sealed).is_ok(), "the right row still opens");
    }

    #[test]
    fn a_value_cannot_be_moved_between_columns_or_accounts() {
        let k = key();
        let subject = field_aad("acct", "messages", "subject", "row-1");
        let preview = field_aad("acct", "messages", "preview", "row-1");
        let other_account = field_aad("other", "messages", "subject", "row-1");
        let sealed = seal(&k, &subject, b"hello");
        assert_eq!(open(&k, &preview, &sealed), Err(CryptError::NotAuthentic));
        assert_eq!(
            open(&k, &other_account, &sealed),
            Err(CryptError::NotAuthentic)
        );
    }

    #[test]
    fn the_field_aad_separator_cannot_be_forged_by_the_inputs() {
        // Same concatenation, different split. NUL separators keep these apart.
        assert_ne!(
            field_aad("a", "messages", "subject", "1"),
            field_aad("a", "messagessubject", "", "1")
        );
    }

    #[test]
    fn a_wrong_key_fails_the_same_way_a_tampered_value_does() {
        let sealed = seal(&key(), b"aad", b"payload");
        let other = Key::from_bytes([9u8; 32]);
        assert_eq!(open(&other, b"aad", &sealed), Err(CryptError::NotAuthentic));

        let mut tampered = sealed.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 1;
        assert_eq!(
            open(&key(), b"aad", &tampered),
            Err(CryptError::NotAuthentic)
        );
    }

    #[test]
    fn a_non_envelope_is_reported_as_such_and_not_as_a_key_failure() {
        let k = key();
        assert_eq!(open(&k, b"", b""), Err(CryptError::NotAnEnvelope));
        assert_eq!(
            open(&k, b"", b"a plaintext subject line"),
            Err(CryptError::NotAnEnvelope)
        );
        // Right magic, too short to hold a nonce and a tag.
        assert_eq!(
            open(&k, b"", b"ELMC\x01\x01"),
            Err(CryptError::NotAnEnvelope)
        );
    }

    #[test]
    fn a_future_version_or_algorithm_is_refused_rather_than_misread() {
        let k = key();
        let mut sealed = seal(&k, b"", b"x");
        sealed[4] = 2;
        assert_eq!(
            open(&k, b"", &sealed),
            Err(CryptError::UnsupportedVersion(2))
        );

        let mut sealed = seal(&k, b"", b"x");
        sealed[5] = 2;
        assert_eq!(
            open(&k, b"", &sealed),
            Err(CryptError::UnsupportedAlgorithm(2))
        );
    }

    #[test]
    fn looks_sealed_separates_plaintext_from_envelopes() {
        assert!(looks_sealed(&seal(&key(), b"", b"x")));
        assert!(!looks_sealed(b"Re: your invoice"));
        assert!(!looks_sealed(b""));
    }

    #[test]
    fn subkeys_are_distinct_and_deterministic() {
        let keys = MailKeys::derive(Key::from_bytes([1u8; 32]));
        let again = MailKeys::derive(Key::from_bytes([1u8; 32]));
        assert_eq!(keys.field.as_bytes(), again.field.as_bytes());
        for (a, b) in [
            (&keys.field, &keys.blob),
            (&keys.field, &keys.addr),
            (&keys.field, &keys.name),
            (&keys.field, &keys.wrap),
            (&keys.blob, &keys.addr),
            (&keys.name, &keys.wrap),
        ] {
            assert_ne!(a.as_bytes(), b.as_bytes(), "subkeys must not collide");
        }
        let other = MailKeys::derive(Key::from_bytes([2u8; 32]));
        assert_ne!(keys.field.as_bytes(), other.field.as_bytes());
    }

    #[test]
    fn blob_ids_dedupe_by_content_and_hide_it() {
        let addr = Key::from_bytes([3u8; 32]);
        let a = blob_id(&addr, b"attachment bytes");
        assert_eq!(a, blob_id(&addr, b"attachment bytes"), "dedupe still works");
        assert_eq!(
            a.len(),
            64,
            "still 64 hex chars, so get_blob's check is unchanged"
        );
        assert!(a.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_ne!(a, blob_id(&addr, b"other bytes"));
        // The point of keying it: the same file under a different store is a
        // different name, so a directory listing confirms nothing.
        assert_ne!(a, blob_id(&Key::from_bytes([4u8; 32]), b"attachment bytes"));
    }

    #[test]
    fn name_digests_preserve_equality_and_nothing_else() {
        let name = Key::from_bytes([5u8; 32]);
        assert_eq!(
            name_digest(&name, "a1", "INBOX"),
            name_digest(&name, "a1", "INBOX")
        );
        assert_ne!(
            name_digest(&name, "a1", "INBOX"),
            name_digest(&name, "a2", "INBOX")
        );
        assert_ne!(
            name_digest(&name, "a1", "INBOX"),
            name_digest(&name, "a1", "Sent")
        );
    }

    // ── Key file ────────────────────────────────────────────────────────────

    #[test]
    fn a_passphrase_store_opens_with_the_passphrase_and_not_without() {
        let dir = tempfile::tempdir().unwrap();
        // The default parameters are 64 MiB and slow on purpose; the round-trip
        // is what is under test, not the cost, so this writes a cheap file by
        // hand through the same code path.
        let keys = enable_with_cheap_kdf(dir.path(), "correct horse");
        let field = keys.field.as_bytes().to_vec();
        drop(keys);

        let back = unlock_with_passphrase(dir.path(), "correct horse").unwrap();
        assert_eq!(
            back.field.as_bytes().to_vec(),
            field,
            "same master, same subkeys"
        );
        assert!(unlock_with_passphrase(dir.path(), "wrong horse").is_err());
    }

    #[test]
    fn a_passphrase_store_asks_for_one_rather_than_degrading() {
        let dir = tempfile::tempdir().unwrap();
        enable_with_cheap_kdf(dir.path(), "pw");
        assert!(matches!(unlock(dir.path()), Unlock::NeedsPassphrase));
    }

    #[test]
    fn an_unencrypted_store_reports_disabled() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!is_enabled(dir.path()));
        assert!(matches!(unlock(dir.path()), Unlock::Disabled));
    }

    #[test]
    fn a_key_file_from_the_future_degrades_rather_than_guessing() {
        let dir = tempfile::tempdir().unwrap();
        enable_with_cheap_kdf(dir.path(), "pw");
        let mut file = read_key_file(dir.path()).unwrap().unwrap();
        file.version = 99;
        write_key_file(dir.path(), &file).unwrap();
        assert!(matches!(unlock(dir.path()), Unlock::Unavailable(_)));
    }

    #[test]
    fn kdf_parameters_survive_the_key_file_and_are_what_unlock_uses() {
        let dir = tempfile::tempdir().unwrap();
        let cheap = KdfParams {
            m_cost: 8,
            t_cost: 1,
            p_cost: 1,
        };
        let keys = enable_with_cheap_kdf(dir.path(), "pw");
        drop(keys);
        let file = read_key_file(dir.path()).unwrap().unwrap();
        assert_eq!(
            file.kdf, cheap,
            "the parameters used must be the ones recorded"
        );
        // Reading it back with the recorded parameters is the only way the
        // unlock can succeed; if `unlock_with_passphrase` ignored them and used
        // the defaults it would derive a different KEK and fail.
        assert!(unlock_with_passphrase(dir.path(), "pw").is_ok());
    }

    #[test]
    fn enabling_twice_refuses_rather_than_destroying_the_store() {
        let dir = tempfile::tempdir().unwrap();
        enable_with_cheap_kdf(dir.path(), "pw");
        assert!(enable_with_passphrase(dir.path(), "another").is_err());
    }

    /// `enable_with_passphrase` with parameters cheap enough for a test suite.
    /// Everything else about the path — salt, wrap, file layout — is identical,
    /// which is what makes the assertions above mean anything.
    fn enable_with_cheap_kdf(dir: &Path, passphrase: &str) -> MailKeys {
        enable_with_cheap_kdf_for(&crate::brand::PAIR, dir, passphrase)
    }

    /// The same for a build with the brand pair `pair`.
    fn enable_with_cheap_kdf_for(pair: &crate::brand::Pair, dir: &Path, passphrase: &str) -> MailKeys {
        let labels = LabelSet::current(pair);
        let master = Key::random().unwrap();
        let salt = fresh_salt().unwrap();
        let kdf = KdfParams {
            m_cost: 8,
            t_cost: 1,
            p_cost: 1,
        };
        let kek = derive_passphrase_kek(passphrase, &salt, kdf).unwrap();
        let file = MailKeyFile {
            version: KEY_FILE_VERSION,
            mode: UnlockMode::Passphrase,
            kdf,
            salt: B64.encode(&salt),
            wrapped: B64.encode(seal(&kek, labels.wrap_aad.as_bytes(), master.as_bytes())),
            labels: labels.key_file_entry(pair),
        };
        write_key_file(dir, &file).unwrap();
        MailKeys::derive_with(master, labels)
    }

    /// A build before the rename: both halves of its pair are the old name.
    const BEFORE: crate::brand::Pair = crate::brand::Pair {
        cur: crate::brand::LEGACY,
        legacy: crate::brand::LEGACY,
    };
    /// A build after it, under an invented name.
    const RENAMED: crate::brand::Pair = crate::brand::Pair {
        cur: crate::brand::Forms { display: "Newname", slug: "newname", upper: "NEWNAME" },
        legacy: crate::brand::LEGACY,
    };

    /// One value of each kind a store holds, sealed under `keys`.
    fn sealed_records(keys: &MailKeys) -> Vec<(&'static str, Vec<u8>, Vec<u8>)> {
        let field = field_aad("acct", "messages", "subject", "m1");
        let blob_bytes = b"attachment bytes".to_vec();
        let blob = blob_aad(&blob_id(&keys.addr, &blob_bytes));
        vec![
            ("field", field.clone(), seal(&keys.field, &field, b"Re: the contract")),
            ("blob", blob.clone(), seal(&keys.blob, &blob, &blob_bytes)),
            ("accounts", accounts_aad(), seal(&keys.field, &accounts_aad(), b"[{\"id\":\"acct\"}]")),
            ("keyring", b"pgp".to_vec(), seal(&keys.wrap, b"pgp", b"secret key material")),
        ]
    }

    fn opens_all(keys: &MailKeys, records: &[(&'static str, Vec<u8>, Vec<u8>)]) -> bool {
        records.iter().all(|(kind, aad, sealed)| {
            let key = match *kind {
                "blob" => &keys.blob,
                "keyring" => &keys.wrap,
                _ => &keys.field,
            };
            open(key, aad, sealed).is_ok()
        })
    }

    /// THE property of the label sets: a store an older build wrote opens,
    /// every record of it, after the app was renamed — because its key file
    /// names no set and that is read as the old name's. Nothing in the store
    /// is rewritten to get there.
    #[test]
    fn a_store_written_before_a_rename_opens_after_it_untouched() {
        use crate::services::brand_migration::hits;
        let dir = tempfile::tempdir().unwrap();
        let before = enable_with_cheap_kdf_for(&BEFORE, dir.path(), "pw");
        let records = sealed_records(&before);
        let name_digest_before = name_digest(&before.name, "acct", "INBOX");
        let key_file = std::fs::read(key_file_path(dir.path())).unwrap();
        assert!(!String::from_utf8_lossy(&key_file).contains("labels"));

        let _ = hits::taken();
        let after = unlock_with_passphrase_for(&RENAMED, dir.path(), "pw").expect("unlocks");
        assert_eq!(hits::taken(), ["mail-labels"]);
        assert!(opens_all(&after, &records));
        assert_eq!(name_digest(&after.name, "acct", "INBOX"), name_digest_before);
        assert_eq!(blob_id(&after.addr, b"x"), blob_id(&before.addr, b"x"));
        assert_eq!(*after.labels, LabelSet::of(&crate::brand::LEGACY));
        // Unlocking wrote nothing.
        assert_eq!(std::fs::read(key_file_path(dir.path())).unwrap(), key_file);
    }

    /// A store the renamed build creates is written under the current set,
    /// says so in its key file, and shares no subkey with the old set.
    #[test]
    fn a_store_created_after_a_rename_uses_the_current_labels() {
        use crate::services::brand_migration::hits;
        let dir = tempfile::tempdir().unwrap();
        let created = enable_with_cheap_kdf_for(&RENAMED, dir.path(), "pw");
        let file = read_key_file(dir.path()).unwrap().unwrap();
        assert_eq!(file.labels.as_deref(), Some("newname/mail/v1/"));
        let records = sealed_records(&created);

        let _ = hits::taken();
        let reopened = unlock_with_passphrase_for(&RENAMED, dir.path(), "pw").expect("unlocks");
        assert!(hits::taken().is_empty());
        assert!(opens_all(&reopened, &records));
        assert_eq!(*reopened.labels, LabelSet::current(&RENAMED));

        // The same master under the old set gives other keys altogether.
        let master = || Key::from_bytes([3u8; 32]);
        let old = MailKeys::derive_with(master(), LabelSet::of(&crate::brand::LEGACY));
        let new = MailKeys::derive_with(master(), LabelSet::current(&RENAMED));
        for (a, b) in [
            (&old.field, &new.field),
            (&old.blob, &new.blob),
            (&old.addr, &new.addr),
            (&old.name, &new.name),
            (&old.wrap, &new.wrap),
        ] {
            assert_ne!(a.as_bytes(), b.as_bytes());
        }
        // And the build before the rename cannot open it by mistake: it does
        // not know the set the file names.
        assert!(unlock_with_passphrase_for(&BEFORE, dir.path(), "pw").is_err());
    }

    /// A key file is editable by anyone who can write the mail folder: a
    /// label set this build does not know is refused, not derived from.
    #[test]
    fn an_unknown_label_set_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        enable_with_cheap_kdf_for(&RENAMED, dir.path(), "pw");
        let mut file = read_key_file(dir.path()).unwrap().unwrap();
        file.labels = Some("someone-else/mail/v1/".into());
        write_key_file(dir.path(), &file).unwrap();
        let error = unlock_with_passphrase_for(&RENAMED, dir.path(), "pw").unwrap_err();
        assert!(error.contains("label set"), "{error}");
    }

    /// While the name is unchanged: the key file has no `labels` entry (the
    /// format older builds read), the labels are what they always were, and
    /// no store counts as being on old labels.
    #[test]
    fn with_the_name_unchanged_the_key_file_and_the_labels_are_what_they_were() {
        let pair = crate::brand::PAIR;
        if pair.renamed() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let keys = enable_with_cheap_kdf(dir.path(), "pw");
        let file = String::from_utf8(std::fs::read(key_file_path(dir.path())).unwrap()).unwrap();
        assert!(!file.contains("labels"), "{file}");
        assert!(!keys.on_legacy_labels());
        let labels = LabelSet::current(&pair);
        assert_eq!(labels.label("field"), crate::brand::mail_label("field"));
        assert_eq!(labels.wrap_aad, crate::brand::MAIL_WRAP_AAD);
        assert_eq!(labels, LabelSet::of(&crate::brand::LEGACY));
        // Derived exactly as before this module knew of label sets.
        let hk = Hkdf::<Sha256>::new(None, &[5u8; 32]);
        let derived = MailKeys::derive(Key::from_bytes([5u8; 32]));
        assert_eq!(
            derived.field.as_bytes(),
            subkey(&hk, &crate::brand::mail_label("field")).as_bytes()
        );
        assert_eq!(
            derived.wrap.as_bytes(),
            subkey(&hk, &crate::brand::mail_label("wrap")).as_bytes()
        );
    }
}

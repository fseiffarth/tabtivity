//! The OpenPGP keyring (`docs/mail_encryption_plan.md` §6, Phase 4).
//!
//! rPGP (`pgp` 0.20) rather than `sequoia-openpgp`, for two reasons that both
//! survived checking: sequoia is **LGPL-2.0-or-later**, which is a real
//! constraint for a statically linked binary this project redistributes, and its
//! pure-Rust backend sits behind `allow-experimental-crypto` +
//! `allow-variable-time-crypto` while its default backend is Nettle — a C
//! library, which the no-OpenSSL/no-C-toolchain invariant rules out.
//!
//! # Curve25519 by default, and why that is a security decision
//!
//! `pgp` depends on `rsa` unconditionally, and `rsa` is under
//! **RUSTSEC-2023-0071** (Marvin timing oracle) with `patched = []`. No version
//! escapes it and no feature gates it out; the `cargo audit` finding is
//! permanent. What *can* be avoided is ever running the vulnerable code.
//!
//! The oracle is in RSA PKCS#1 v1.5 **decryption**. Nobody can encrypt to a key
//! we do not have — so if our own key is Curve25519, that path is never
//! exercised for our mail, even though the crate is compiled in. Hence
//! [`PgpKeyring::generate`] offers no RSA option at all. RSA keys stay
//! *importable*, because a correspondent's key is only ever used to **verify**,
//! which is signature checking and not the vulnerable operation.
//!
//! The v4 (`Ed25519Legacy` + `ECDH(Curve25519Legacy)`) forms are generated
//! rather than the RFC 9580 v6 ones, deliberately: interoperating with
//! Thunderbird, GnuPG and Outlook is the whole point of using a standard, and v6
//! support is not yet where v4 support is.
//!
//! # Verified vs merely known
//!
//! OpenPGP has **no certificate authority**. There is no `webpki` to lean on and
//! nothing asserting that a key belongs to a person — trust comes from the user
//! having compared a fingerprint out of band, and from nothing else. So every
//! entry carries a [`SignerTrust`], it starts at `Known`, and only an explicit
//! "I checked this fingerprint" click promotes it. A good signature from a
//! `Known` key is a statement about bytes; the UI is not allowed to dress it as
//! a statement about a person.
//!
//! # The keyring requires the store to be encrypted
//!
//! [`PgpKeyring::open`] takes `MailKeys` and there is no path that does not.
//! Writing a private key into a plaintext file would make the whole exercise
//! theatre — and it is exactly the coupling the plan sequences the phases
//! around. Secret material is sealed under `k_wrap`, deliberately *not*
//! `k_field`, so the mail index and the private keys are not one compromise.

use std::path::{Path, PathBuf};

use base64::Engine as _;
use pgp::composed::{
    Deserializable, EncryptionCaps, KeyType, SecretKeyParamsBuilder, SignedPublicKey,
    SignedSecretKey, SubkeyParamsBuilder,
};
use pgp::crypto::ecc_curve::ECCCurve;
use pgp::ser::Serialize as _;
use pgp::types::KeyDetails as _;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::services::mail_crypt::{self, MailKeys};
use crate::services::mail_crypto::{
    CryptoKind, DecryptError, MailCrypto, SignerTrust, VerifyOutcome,
};

const B64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::STANDARD;

/// `<mail dir>/pgp.json`, one sealed file.
///
/// One file rather than a directory of keys: the whole ring is a few kilobytes,
/// it is written rarely, and a single atomic write cannot leave the metadata and
/// the material disagreeing about which keys exist.
const KEYRING_FILE: &str = "pgp.json";
const KEYRING_AAD: &[u8] = b"file:pgp.json";
const KEYRING_VERSION: u32 = 1;

// ── The stored shape ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
struct KeyringFile {
    version: u32,
    #[serde(default)]
    entries: Vec<StoredKey>,
    /// The one-time demotion of private keys an older build imported as
    /// Verified has run (see [`demote_imported_secrets`]). A marker rather than
    /// a `version` bump: an older build refuses a newer version outright, and
    /// this field it simply ignores.
    #[serde(default)]
    secret_trust_migrated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredKey {
    fingerprint: String,
    #[serde(default)]
    identities: Vec<String>,
    /// Whether `material` is a transferable *secret* key.
    secret: bool,
    /// `true` once the user has confirmed the fingerprint out of band, bound
    /// this (secret) key to one of their accounts, or generated it here.
    #[serde(default)]
    verified: bool,
    /// Mail account ids this key is the identity for. Only meaningful for a
    /// secret key.
    #[serde(default)]
    accounts: Vec<String>,
    #[serde(default)]
    algorithm: String,
    /// Where the key came from. Absent in files an older build wrote: read it
    /// through [`origin_of`], never directly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    origin: Option<KeyOrigin>,
    /// Base64 of the binary OpenPGP key packet stream.
    material: String,
}

/// Whether a key was made on this machine or came in from outside. Only the
/// first is something the user watched happen; an imported *private* key is a
/// file somebody else may hold the other copy of, so binding one as the
/// account's identity needs an explicit acknowledgement and never earns
/// Verified by itself (gap 91).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyOrigin {
    Generated,
    #[default]
    Imported,
}

/// One key, as the UI sees it. Carries **no key material** — the panel and the
/// key list have no use for it, and a type that cannot leak a private key
/// through a serialization mistake is worth the extra struct.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PgpKeyInfo {
    /// Uppercase hex, no spaces.
    pub fingerprint: String,
    /// The user ids as written on the key.
    pub identities: Vec<String>,
    /// Addresses extracted from those user ids, lowercased.
    pub addresses: Vec<String>,
    /// We hold the private half: this is one of the user's own keys.
    pub secret: bool,
    /// The user has compared this fingerprint out of band — or, for one of
    /// their own keys, generated it here or bound it to an account while every
    /// address it names is one of their accounts'.
    pub verified: bool,
    pub accounts: Vec<String>,
    pub algorithm: String,
    /// Generated here or imported (see [`KeyOrigin`]).
    #[serde(default)]
    pub origin: KeyOrigin,
    /// The key carries a verified revocation. Computed when read, never stored.
    #[serde(default)]
    pub revoked: bool,
    /// The key's expiry has passed. Computed when read, never stored.
    #[serde(default)]
    pub expired: bool,
    /// Machine tokens for what an import or a bind just did to the key's
    /// trust, which the dialog turns into sentences: `identities-changed-
    /// unverified`, `identities-changed-unbound`, `bound-imported-unverified`.
    /// Only the answer to that one call carries any; a later read has none.
    #[serde(default)]
    pub notes: Vec<String>,
}

impl PgpKeyInfo {
    pub fn trust(&self) -> SignerTrust {
        if self.verified {
            SignerTrust::Verified
        } else {
            SignerTrust::Known
        }
    }
}

// ── The keyring ─────────────────────────────────────────────────────────────

pub struct PgpKeyring {
    path: PathBuf,
    wrap: mail_crypt::Key,
    /// The `wrap` keys of previous masters while a server's mailbox re-keys
    /// (hosted plan §6.8): read with, never written with.
    old_wraps: Vec<mail_crypt::Key>,
    /// [`mail_crypt::side_files`]' switch count when the keys were read; a
    /// write after a switch is refused rather than sealed under replaced keys.
    generation: u64,
}

impl std::fmt::Debug for PgpKeyring {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PgpKeyring")
            .field("path", &self.path)
            .finish()
    }
}

/// The keyring file's plaintext under `keys`, or `None` when there is no keyring.
///
/// For carrying the keyring across a change of store key (an encryption reset):
/// the file is sealed under `k_wrap`, so a new master key would otherwise leave
/// every private key in it unreadable — and there is no secret-key export to
/// have saved them first.
pub fn keyring_plaintext(dir: &Path, keys: &MailKeys) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
    match std::fs::read(dir.join(KEYRING_FILE)) {
        Ok(raw) => keys
            .open_any(|k| &k.wrap, KEYRING_AAD, &raw)
            .map(|(plain, _)| Some(Zeroizing::new(plain.to_vec())))
            .map_err(|e| format!("the keyring could not be decrypted: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Seal `plain` (from [`keyring_plaintext`]) as the keyring under `keys`.
pub fn write_keyring_plaintext(dir: &Path, keys: &MailKeys, plain: &[u8]) -> Result<(), String> {
    let sealed = mail_crypt::seal(&keys.wrap, KEYRING_AAD, plain);
    mail_crypt::write_bytes_atomic(&dir.join(KEYRING_FILE), &sealed)
}

/// A re-key's pass over the keyring file: re-sealed under `keys`' current
/// master if it opens only under a previous one. Whether it was rewritten.
/// The caller holds [`mail_crypt::side_files`].
pub fn reseal_keyring(dir: &Path, keys: &MailKeys) -> Result<bool, String> {
    let path = dir.join(KEYRING_FILE);
    let raw = match std::fs::read(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e.to_string()),
    };
    match keys.open_any(|k| &k.wrap, KEYRING_AAD, &raw) {
        Ok((plain, false)) => {
            mail_crypt::write_bytes_atomic(&path, &mail_crypt::seal(&keys.wrap, KEYRING_AAD, &plain))?;
            Ok(true)
        }
        // Under the current master already, or under none (damaged: left as
        // it is, the keyring reports it itself).
        _ => Ok(false),
    }
}

impl PgpKeyring {
    /// Open (or create) the keyring in `dir`, sealed under the store's `k_wrap`.
    /// `generation`: [`mail_crypt::side_files`]' count, read under the lock
    /// together with `keys`.
    pub fn open(dir: &Path, keys: &MailKeys, generation: u64) -> Result<Self, String> {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        Ok(PgpKeyring {
            path: dir.join(KEYRING_FILE),
            wrap: keys.wrap.clone(),
            old_wraps: keys.previous().iter().map(|k| k.wrap.clone()).collect(),
            generation,
        })
    }

    fn read(&self) -> Result<KeyringFile, String> {
        match std::fs::read(&self.path) {
            Ok(raw) => {
                let plain = std::iter::once(&self.wrap)
                    .chain(self.old_wraps.iter())
                    .find_map(|wrap| mail_crypt::open(wrap, KEYRING_AAD, &raw).ok())
                    .ok_or_else(|| format!("the keyring could not be decrypted: {}", mail_crypt::CryptError::NotAuthentic))?;
                let mut file: KeyringFile = serde_json::from_slice(&plain)
                    .map_err(|e| format!("the keyring is corrupt: {e}"))?;
                if file.version != KEYRING_VERSION {
                    return Err(format!(
                        concat!("this keyring was written by a newer version of ", crate::app_name!(), " (v{})"),
                        file.version
                    ));
                }
                if !file.secret_trust_migrated {
                    demote_imported_secrets(&mut file);
                    // Best effort: a failed write leaves the demotion in this
                    // read's copy and runs it again on the next one.
                    let _ = self.write(&file);
                }
                Ok(file)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(KeyringFile {
                version: KEYRING_VERSION,
                entries: Vec::new(),
                secret_trust_migrated: true,
            }),
            Err(e) => Err(e.to_string()),
        }
    }

    fn write(&self, file: &KeyringFile) -> Result<(), String> {
        let json = Zeroizing::new(serde_json::to_vec(file).map_err(|e| e.to_string())?);
        let side = mail_crypt::side_files();
        if *side != self.generation {
            return Err("the mail store's key changed a moment ago — try again".into());
        }
        let sealed = mail_crypt::seal(&self.wrap, KEYRING_AAD, &json);
        mail_crypt::write_bytes_atomic(&self.path, &sealed)
    }

    pub fn list(&self) -> Result<Vec<PgpKeyInfo>, String> {
        let file = self.read()?;
        Ok(file.entries.iter().map(info_of).collect())
    }

    pub fn get(&self, fingerprint: &str) -> Result<Option<PgpKeyInfo>, String> {
        let fp = normalize_fingerprint(fingerprint);
        Ok(self
            .read()?
            .entries
            .iter()
            .find(|e| e.fingerprint == fp)
            .map(info_of))
    }

    /// Generate a fresh Curve25519 key and bind it to `account_id`.
    ///
    /// No algorithm parameter, and that absence is the point — see the module
    /// header. RSA is importable, never generable.
    pub fn generate(
        &self,
        name: &str,
        address: &str,
        account_id: &str,
    ) -> Result<PgpKeyInfo, String> {
        let uid = user_id_for(name, address);
        let secret = generate_curve25519(&uid)?;

        let mut file = self.read()?;
        let fingerprint = fingerprint_hex(&secret.fingerprint());
        let material = secret
            .to_bytes()
            .map_err(|e| format!("could not serialize the new key: {e}"))?;
        let entry = StoredKey {
            fingerprint: fingerprint.clone(),
            identities: user_ids_of_details(&secret.details),
            secret: true,
            // A key we generated on this machine needs no out-of-band check: we
            // watched it being made. Besides binding an account (the user naming
            // it their identity), this is the one place `verified` is set without
            // a fingerprint comparison, and it is not a shortcut.
            verified: true,
            accounts: vec![account_id.to_string()],
            algorithm: "Curve25519".into(),
            origin: Some(KeyOrigin::Generated),
            material: B64.encode(&material),
        };
        // One key per account. Generating a replacement takes the binding over
        // rather than adding a second — two keys claiming one account makes
        // "which key signs this message" a question with two answers. The old
        // key is *kept*, only unbound: it is still the key that decrypts every
        // message already received under it.
        for e in file.entries.iter_mut() {
            e.accounts.retain(|a| a != account_id);
        }
        file.entries.retain(|e| e.fingerprint != fingerprint);
        file.entries.push(entry.clone());
        self.write(&file)?;
        Ok(info_of(&entry))
    }

    /// Import one or more keys from armored or binary OpenPGP data.
    ///
    /// Both halves are accepted, and a *secret* import replaces a public entry
    /// for the same fingerprint rather than sitting beside it: holding the
    /// private half strictly supersedes holding only the public one, and two
    /// entries with one fingerprint would make every lookup a coin flip.
    ///
    /// An imported key is `Known`, never `Verified` — importing is not
    /// checking. That holds for a *secret* key too: holding the private half
    /// proves nothing about whose its user ids are, and "here is my key" can be
    /// a secret key an attacker made with a friend's address on it. Only
    /// [`PgpKeyring::set_verified`] (an explicit "I compared this fingerprint"
    /// click) or [`PgpKeyring::bind_account`] (an explicit "this is my
    /// identity", for a key naming only the user's own addresses, and for an
    /// imported private key never) promotes it.
    ///
    /// Re-importing a key we already hold keeps its flag, its account bindings
    /// and its origin **only while its user-id set is the same**. A fingerprint
    /// does not cover the user ids: the key's owner can re-certify other ones
    /// under it, so a copy naming somebody else's address would otherwise keep
    /// the tick the user gave the old claim (gap 76). A changed set resets the
    /// key to unverified and, for a secret key, drops its account bindings (the
    /// bind checked the ids only when it was made); the returned info says so in
    /// `notes`.
    pub fn import(&self, data: &[u8]) -> Result<Vec<PgpKeyInfo>, String> {
        let mut file = self.read()?;
        let mut added = Vec::new();

        // Secret first: a transferable secret key also parses as a public one in
        // some readers, and the secret half is the more useful reading.
        let secrets = SignedSecretKey::from_reader_many(data)
            .ok()
            .map(|(iter, _)| iter.flatten().collect::<Vec<_>>())
            .unwrap_or_default();
        for mut key in secrets {
            key.verify_bindings()
                .map_err(|e| format!("this key's own self-signatures do not check out: {e}"))?;
            let fingerprint = fingerprint_hex(&key.fingerprint());
            carry_revocations(
                &file,
                &fingerprint,
                &mut key.details,
                key.secret_subkeys
                    .iter_mut()
                    .map(|s| (s.key.fingerprint(), &mut s.signatures))
                    .collect(),
            );
            let material = key.to_bytes().map_err(|e| e.to_string())?;
            added.push(record_import(&mut file, fingerprint, &key.details, algorithm_label(key.algorithm()), &material, true));
        }

        if added.is_empty() {
            let (publics, _) = SignedPublicKey::from_reader_many(data)
                .map_err(|_| "this does not look like an OpenPGP key".to_string())?;
            for mut key in publics.flatten() {
                key.verify_bindings()
                    .map_err(|e| format!("this key's own self-signatures do not check out: {e}"))?;
                let fingerprint = fingerprint_hex(&key.fingerprint());
                // Never downgrade: re-importing the public half of a key whose
                // private half we hold must not throw the private half away.
                if file
                    .entries
                    .iter()
                    .any(|e| e.fingerprint == fingerprint && e.secret)
                {
                    continue;
                }
                carry_revocations(
                    &file,
                    &fingerprint,
                    &mut key.details,
                    key.public_subkeys
                        .iter_mut()
                        .map(|s| (s.key.fingerprint(), &mut s.signatures))
                        .collect(),
                );
                let material = key.to_bytes().map_err(|e| e.to_string())?;
                added.push(record_import(&mut file, fingerprint, &key.details, algorithm_label(key.algorithm()), &material, false));
            }
        }

        if added.is_empty() {
            return Err("no OpenPGP key was found in that data".into());
        }
        self.write(&file)?;
        Ok(added)
    }

    /// Record that the user compared this key's fingerprint out of band.
    ///
    /// The only way a correspondent's key becomes `Verified` (an own key also
    /// gets there by being generated here or bound to an account), and
    /// therefore the only way their messages earn positive chrome. It is a
    /// deliberate, per-key, user-initiated act — there is no heuristic that can
    /// stand in for it, because there is no authority to ask.
    pub fn set_verified(&self, fingerprint: &str, verified: bool) -> Result<PgpKeyInfo, String> {
        let fp = normalize_fingerprint(fingerprint);
        let mut file = self.read()?;
        let entry = file
            .entries
            .iter_mut()
            .find(|e| e.fingerprint == fp)
            .ok_or("no such key")?;
        entry.verified = verified;
        let info = info_of(entry);
        self.write(&file)?;
        Ok(info)
    }

    /// Bind (or with `bind == false`, unbind) one of our own keys to a mail
    /// account.
    ///
    /// Binding needs the key's user ids to name `account_address`: a key that
    /// does not name the address it would sign for is not that account's
    /// identity, however it got into the keyring. Binding is also the user
    /// saying "this key is mine", so it promotes a key **generated here** to
    /// `Verified` — but only when *every* address on it is one of
    /// `own_addresses` (all the user's accounts). A key that also names somebody
    /// else stays as trusted as it was, or binding it would vouch for that
    /// somebody too. Unbinding does not demote: the key is still the user's,
    /// only no longer this account's. `account_address` and `own_addresses` are
    /// unused for it.
    ///
    /// An **imported** private key is different (gap 91): whoever made the file
    /// holds a copy of the private half, so binding it makes them able to sign
    /// as the account and to read the copies encrypted to it. The call refuses
    /// unless `acknowledge_imported` says the user was told so (the dialog's
    /// confirm; enforced here, so a client that skips the dialog gets the
    /// refusal too), and even then never sets `Verified`: the user ticks the
    /// fingerprint like any key's. The returned info carries the note
    /// `bound-imported-unverified` for that case.
    pub fn bind_account(
        &self,
        fingerprint: &str,
        account_id: &str,
        bind: bool,
        account_address: &str,
        own_addresses: &[String],
        acknowledge_imported: bool,
    ) -> Result<PgpKeyInfo, String> {
        let fp = normalize_fingerprint(fingerprint);
        let mut file = self.read()?;
        let at = file
            .entries
            .iter()
            .position(|e| e.fingerprint == fp)
            .ok_or("no such key")?;
        let mut notes = Vec::new();
        if bind {
            let entry = &file.entries[at];
            if !entry.secret {
                return Err(
                    "only a key you hold the private half of can be an account's identity".into(),
                );
            }
            let addresses = addresses_of(entry);
            let wanted = account_address.trim().to_ascii_lowercase();
            if !addresses.contains(&wanted) {
                return Err(format!(
                    "this key's user ids do not name {wanted}, so it cannot be that account's identity"
                ));
            }
            let imported = origin_of(entry) == KeyOrigin::Imported;
            if imported && !acknowledge_imported {
                return Err(
                    "this private key was imported, not made here: whoever made the file can sign as this account and read what is encrypted to it. Confirm that you know where it came from to use it anyway".into(),
                );
            }
            let all_ours = addresses
                .iter()
                .all(|a| own_addresses.iter().any(|o| o.trim().eq_ignore_ascii_case(a)));
            // One key per account: a second binding would make "which key signs
            // this message" a question with two answers.
            for e in file.entries.iter_mut() {
                e.accounts.retain(|a| a != account_id);
            }
            let entry = &mut file.entries[at];
            entry.accounts.push(account_id.to_string());
            if imported {
                if !entry.verified {
                    notes.push("bound-imported-unverified".to_string());
                }
            } else if all_ours {
                entry.verified = true;
            }
        } else {
            file.entries[at].accounts.retain(|a| a != account_id);
        }
        self.write(&file)?;
        let mut info = info_of(&file.entries[at]);
        info.notes = notes;
        Ok(info)
    }

    pub fn delete(&self, fingerprint: &str) -> Result<(), String> {
        let fp = normalize_fingerprint(fingerprint);
        let mut file = self.read()?;
        let before = file.entries.len();
        file.entries.retain(|e| e.fingerprint != fp);
        if file.entries.len() == before {
            return Err("no such key".into());
        }
        self.write(&file)
    }

    /// The armored public half, for sending to a correspondent.
    ///
    /// Public only, always — there is no command in this module that exports a
    /// private key, and that is not an omission. "Export my key" typed by
    /// somebody who means the public half is the standard way a private key ends
    /// up in an email.
    pub fn export_public(&self, fingerprint: &str) -> Result<String, String> {
        let fp = normalize_fingerprint(fingerprint);
        let file = self.read()?;
        let entry = file
            .entries
            .iter()
            .find(|e| e.fingerprint == fp)
            .ok_or("no such key")?;
        let material = B64.decode(&entry.material).map_err(|e| e.to_string())?;
        let public = if entry.secret {
            SignedPublicKey::from(
                SignedSecretKey::from_bytes(&material[..]).map_err(|e| e.to_string())?,
            )
        } else {
            SignedPublicKey::from_bytes(&material[..]).map_err(|e| e.to_string())?
        };
        public
            .to_armored_string(Default::default())
            .map_err(|e| e.to_string())
    }

    // ── Lookups the crypto operations run on ────────────────────────────────

    /// The secret key bound to `account_id`, if any.
    pub fn secret_for_account(&self, account_id: &str) -> Result<Option<SignedSecretKey>, String> {
        let file = self.read()?;
        let Some(entry) = file
            .entries
            .iter()
            .find(|e| e.secret && e.accounts.iter().any(|a| a == account_id))
        else {
            return Ok(None);
        };
        Ok(Some(parse_secret(entry)?))
    }

    /// Every secret key we hold.
    ///
    /// Decryption tries all of them, because an OpenPGP message names its
    /// recipients by key id and a key id can be a wildcard (`0`, "hidden
    /// recipient"). Trying each is the only correct behaviour, and the failure
    /// is the same single indistinguishable one either way.
    pub fn secret_keys(&self) -> Result<Vec<SignedSecretKey>, String> {
        let file = self.read()?;
        file.entries
            .iter()
            .filter(|e| e.secret)
            .map(parse_secret)
            .collect()
    }

    /// A public key by fingerprint (accepts the spaced/lowercase forms users
    /// paste).
    pub fn public_by_fingerprint(
        &self,
        fingerprint: &str,
    ) -> Result<Option<SignedPublicKey>, String> {
        let fp = normalize_fingerprint(fingerprint);
        let file = self.read()?;
        match file.entries.iter().find(|e| e.fingerprint == fp) {
            Some(entry) => parse_public(entry).map(Some),
            None => Ok(None),
        }
    }

    /// Every key that could have produced a signature, with its trust.
    ///
    /// Returns candidates rather than one key because a detached signature names
    /// its issuer by **key id** (64 bits) or fingerprint, and a key id is short
    /// enough to collide — deliberately, historically, and cheaply. Picking "the"
    /// key by a 64-bit match and reporting a pass would let anyone who generated
    /// a colliding key id have their signature attributed to someone else. The
    /// caller checks the signature against each candidate instead, so the
    /// cryptography decides which key it was, not the label.
    /// Matching is against the primary fingerprint **and every subkey's**, which
    /// is not a nicety: signing is done by a *signing subkey* on every ordinary
    /// modern key, so a signature's issuer is the subkey's fingerprint and never
    /// the one the keyring is indexed by. Comparing only the primary reports
    /// "no key for this signer" for keys we are holding — the failure this
    /// function was written wrong once and caught by the round-trip test.
    ///
    /// A key id is the last 8 bytes of a v4 fingerprint, so one `ends_with`
    /// covers both spellings.
    ///
    /// A key with a verified revocation, or one whose expiry has passed, is not
    /// a candidate (gap 88): [`PgpKeyring::verify_detached`] reports it as
    /// such rather than as a good signature from a key nobody should trust.
    pub fn candidates_for(
        &self,
        key_ids: &[String],
    ) -> Result<Vec<(SignedPublicKey, PgpKeyInfo)>, String> {
        Ok(self
            .candidates_with_standing(key_ids)?
            .into_iter()
            .filter(|(_, _, standing)| *standing == Standing::Live)
            .map(|(key, info, _)| (key, info))
            .collect())
    }

    /// [`PgpKeyring::candidates_for`] without the revocation/expiry filter, each
    /// key with its [`Standing`] now.
    fn candidates_with_standing(
        &self,
        key_ids: &[String],
    ) -> Result<Vec<(SignedPublicKey, PgpKeyInfo, Standing)>, String> {
        let file = self.read()?;
        let wanted: Vec<String> = key_ids
            .iter()
            .map(|k| normalize_fingerprint(k))
            .filter(|k| !k.is_empty())
            .collect();
        let now = now_secs();
        let mut out = Vec::new();
        for entry in &file.entries {
            let key = parse_public(entry)?;
            let hit = wanted.is_empty()
                || wanted.iter().any(|w| {
                    let primary = fingerprint_hex(&key.fingerprint());
                    primary.ends_with(w.as_str())
                        || w.ends_with(&primary)
                        || key.public_subkeys.iter().any(|sub| {
                            let fp = fingerprint_hex(&sub.key.fingerprint());
                            fp.ends_with(w.as_str()) || w.ends_with(&fp)
                        })
                });
            if hit {
                let (revoked, expired) = key_status(&key, now);
                let info = info_with(entry, revoked, expired);
                out.push((key, info, Standing::of(revoked, expired)));
            }
        }
        Ok(out)
    }

    /// The public key to encrypt to for `address`, if we hold one. A revoked or
    /// expired key is never chosen, however much the user trusts it (gap 88).
    pub fn public_for_address(
        &self,
        address: &str,
    ) -> Result<Option<(SignedPublicKey, PgpKeyInfo)>, String> {
        let wanted = address.trim().to_ascii_lowercase();
        let file = self.read()?;
        let now = now_secs();
        // Prefer a verified key over a merely known one with the same address:
        // if the user has checked one of them, that is the one they meant.
        let mut best: Option<(&StoredKey, SignedPublicKey, bool, bool)> = None;
        for entry in &file.entries {
            if !addresses_of(entry).contains(&wanted) {
                continue;
            }
            let Ok(key) = parse_public(entry) else {
                continue;
            };
            let (revoked, expired) = key_status(&key, now);
            if revoked || expired {
                continue;
            }
            if best
                .as_ref()
                .is_none_or(|(b, ..)| !b.verified && entry.verified)
            {
                best = Some((entry, key, revoked, expired));
            }
        }
        Ok(best.map(|(entry, key, revoked, expired)| (key, info_with(entry, revoked, expired))))
    }
}

// ── Verify, decrypt, seal (phases 5–7) ──────────────────────────────────────

impl PgpKeyring {
    /// Check a detached signature over exactly `signed`.
    ///
    /// The bytes are the caller's problem and getting them wrong is *the* way a
    /// verifier reports a pass over something the sender never signed — see
    /// [`signed_part_bytes`], which is where that job is actually done.
    ///
    /// Every candidate key is tried and the **cryptography** decides which one
    /// it was. Reading the issuer key id and verifying against "the" key with
    /// that id would let anyone who generated a colliding 64-bit id have their
    /// signature attributed to somebody else.
    pub fn verify_detached(&self, signed: &[u8], signature: &[u8]) -> VerifyOutcome {
        use pgp::composed::DetachedSignature;

        let sig = match DetachedSignature::from_bytes(signature)
            .or_else(|_| DetachedSignature::from_armor_single(signature).map(|(s, _)| s))
        {
            Ok(sig) => sig,
            Err(e) => return VerifyOutcome::Unusable(format!("signature-unparseable:{e}")),
        };

        let issuers: Vec<String> = sig
            .signature
            .config()
            .map(|c| {
                c.issuer_fingerprint()
                    .iter()
                    .map(|f| fingerprint_hex(f))
                    .chain(c.issuer_key_id().iter().map(|k| hex_upper(k.as_ref())))
                    .collect()
            })
            .unwrap_or_default();

        let all = match self.candidates_with_standing(&issuers) {
            Ok(c) => c,
            Err(e) => return VerifyOutcome::Unusable(format!("keyring-unreadable:{e}")),
        };
        if all.is_empty() {
            return VerifyOutcome::NoKey {
                key_id: issuers.into_iter().next(),
            };
        }
        // When the signature says it was made. A signature with no creation
        // time cannot be placed inside any key's life, so it passes nothing.
        let made = sig.signature.created().map(|t| t.as_secs());

        // A key that has *expired* still vouches for what it signed before it
        // did (the user's decision on gap 88): the signature has to fall inside
        // the life of the key and of the subkey that made it, else it is Bad.
        // A key, subkey or user ID its owner *revoked* vouches for nothing,
        // whatever the signature's date: a thief of the key can backdate. New
        // encryption and signing never use an expired key (`candidates_for`).
        let mut revoked_hit = false;
        for (key, info, _) in &all {
            let primary = key_window(key);
            // The primary key and every subkey: signing is normally done by a
            // *subkey*, so checking only the primary would fail every ordinary
            // modern key and report it as forged.
            if sig.verify(key, signed).is_ok() || sig.verify(&key.primary_key, signed).is_ok() {
                if primary.revoked {
                    revoked_hit = true;
                } else if made.is_some_and(|t| primary.holds_at(t)) {
                    return good_outcome(info);
                }
                continue;
            }
            for sub in &key.public_subkeys {
                if sig.verify(sub, signed).is_ok() {
                    let sub = subkey_window(sub.key.created_at().as_secs(), &sub.signatures);
                    if primary.revoked || sub.revoked {
                        revoked_hit = true;
                    } else if made.is_some_and(|t| primary.holds_at(t) && sub.holds_at(t)) {
                        return good_outcome(info);
                    }
                }
            }
        }
        if revoked_hit {
            return VerifyOutcome::Unusable("signer-key-revoked".into());
        }
        // A key that could have signed it did not. That is a *failure*, not an
        // absence, and the two must not share chrome.
        VerifyOutcome::Bad
    }

    /// Decrypt an OpenPGP message with whichever of our secret keys fits.
    ///
    /// Every key is tried because a message names its recipients by key id and
    /// that id may be a deliberate wildcard ("hidden recipient"). The failure is
    /// the same single indistinguishable one either way — see
    /// [`DecryptError`] for why that matters more here than it looks.
    pub fn decrypt_message(&self, enveloped: &[u8]) -> Result<Zeroizing<Vec<u8>>, DecryptError> {
        use pgp::composed::Message;

        let secrets = self.secret_keys().map_err(|_| DecryptError::Locked)?;
        if secrets.is_empty() {
            return Err(DecryptError::NoKey);
        }
        let empty = pgp::types::Password::from("");

        for key in &secrets {
            // Armored first, then binary. RFC 3156 puts an ASCII-armored block
            // in the payload part, but an inline (pre-MIME) message can be
            // either, and a binary parse of armored text succeeds far enough to
            // fail confusingly later.
            let Ok(message) = Message::from_armor(enveloped)
                .map(|(m, _)| m)
                .or_else(|_| Message::from_bytes(enveloped))
            else {
                // Not a decryption failure — the bytes are not an OpenPGP
                // message at all, so trying another key would prove nothing.
                return Err(DecryptError::Failed);
            };
            let Ok(mut decrypted) = message.decrypt(&empty, key) else {
                continue;
            };
            if decrypted.is_compressed() {
                let Ok(inner) = decrypted.decompress() else {
                    return Err(DecryptError::Failed);
                };
                decrypted = inner;
            }
            return read_bounded(&mut decrypted);
        }
        Err(DecryptError::Failed)
    }

    /// Sign `body` with the key bound to `account_id`, returning the ASCII-
    /// armored detached signature RFC 3156 puts in the second part.
    pub fn sign_detached(&self, account_id: &str, body: &[u8]) -> Result<String, String> {
        use pgp::composed::DetachedSignature;
        use pgp::crypto::hash::HashAlgorithm;
        use pgp::types::Password;

        let key = self
            .secret_for_account(account_id)?
            .ok_or("this account has no OpenPGP key")?;
        // The **signing subkey**, not the primary: the primary is generated as
        // certify-only (`can_sign(false)`), which is the conventional shape and
        // the one every other client expects.
        let now = now_secs();
        let primary = window_of(key.primary_key.created_at().as_secs(), &key.details);
        let signer = key
            .secret_subkeys
            .iter()
            .find(|s| s.algorithm().can_sign() && subkey_usable(&primary, s.key.created_at().as_secs(), &s.signatures, now))
            .ok_or("this key has no signing subkey that is still valid (it has expired or been revoked)")?;

        // `sign_text_data` rather than `sign_binary_data`: the signature has to
        // survive an MTA rewriting line endings between CRLF and LF, which is
        // routine and which a binary signature does not tolerate.
        let sig = DetachedSignature::sign_text_data(
            rand::rngs::OsRng,
            &signer.key,
            &Password::from(""),
            HashAlgorithm::Sha256,
            body,
        )
        .map_err(|e| format!("could not sign: {e}"))?;
        sig.to_armored_string(Default::default())
            .map_err(|e| e.to_string())
    }

    /// Encrypt `body` to every recipient, plus **ourselves**.
    ///
    /// The encrypt-to-self is not a convenience: without it, a message we send
    /// is a message we can never read again — and, once IMAP `APPEND` exists
    /// (phase 8), the Sent copy would be either plaintext or unreadable. It is
    /// therefore done here rather than left to the caller.
    ///
    /// **Refuses when any recipient has no key.** Silently dropping a recipient
    /// or falling back to plaintext are the two ways an encryption feature
    /// betrays the person using it, so a missing key is an error naming the
    /// address, and the caller turns that into a choice the user makes.
    pub fn encrypt_to(
        &self,
        account_id: &str,
        recipients: &[String],
        body: &[u8],
    ) -> Result<String, String> {
        use pgp::composed::MessageBuilder;
        use pgp::crypto::sym::SymmetricKeyAlgorithm;

        let mut keys: Vec<SignedPublicKey> = Vec::new();
        let mut missing: Vec<String> = Vec::new();
        for address in recipients {
            match self.public_for_address(address)? {
                Some((key, _)) => keys.push(key),
                None => missing.push(address.clone()),
            }
        }
        if !missing.is_empty() {
            return Err(format!("no OpenPGP key for {}", missing.join(", ")));
        }
        if let Some(own) = self.secret_for_account(account_id)? {
            keys.push(SignedPublicKey::from(own));
        } else {
            return Err("this account has no OpenPGP key to encrypt a copy to".into());
        }

        let mut builder = MessageBuilder::from_bytes("", body.to_vec())
            .seipd_v1(rand::rngs::OsRng, SymmetricKeyAlgorithm::AES256);
        let now = now_secs();
        for key in &keys {
            // The **encryption subkey**. Encrypting to a certify-only primary
            // produces a message the recipient's own client cannot open. One
            // that has expired or been revoked is passed over (gap 88): the
            // owner has said it is no longer theirs to be written to.
            let primary = key_window(key);
            let subkey = key
                .public_subkeys
                .iter()
                .find(|s| s.algorithm().can_encrypt() && subkey_usable(&primary, s.key.created_at().as_secs(), &s.signatures, now))
                .ok_or("a recipient's key has no encryption subkey that is still valid (it has expired or been revoked)")?;
            builder
                .encrypt_to_key(rand::rngs::OsRng, subkey)
                .map_err(|e| format!("could not encrypt: {e}"))?;
        }
        // Armored straight out of the builder rather than built binary and
        // re-armored: the second form would parse our own output back in, which
        // is a round trip with nothing to gain and a failure mode to add.
        builder
            .to_armored_string(rand::rngs::OsRng, Default::default())
            .map_err(|e| format!("could not encrypt: {e}"))
    }
}

/// How much of a decrypted plaintext is ever read into memory: one byte past
/// the largest message the engine will parse.
///
/// `Message::as_data_vec` reads its *streaming, decompressing* reader to the
/// end, so a compression bomb inside an encrypted message — an attacker-chosen
/// ratio over bytes that arrive as ordinary mail — expanded into memory without
/// bound. Reading one byte past the cap rather than erroring keeps the existing
/// contract intact: the caller still receives an over-cap plaintext and still
/// refuses it in `parse_message`, with the size reported as a size rather than
/// as a decryption failure. What changes is the allocation.
const MAX_DECRYPTED_READ: u64 = crate::services::mail_engine::MAX_MESSAGE_BYTES as u64 + 1;

/// `Message::as_data_vec` bounded by [`MAX_DECRYPTED_READ`].
fn read_bounded(
    message: &mut pgp::composed::Message<'_>,
) -> Result<Zeroizing<Vec<u8>>, DecryptError> {
    use std::io::Read as _;
    let mut out = Zeroizing::new(Vec::new());
    (&mut *message)
        .take(MAX_DECRYPTED_READ)
        .read_to_end(&mut out)
        .map_err(|_| DecryptError::Failed)?;
    Ok(out)
}

fn good_outcome(info: &PgpKeyInfo) -> VerifyOutcome {
    VerifyOutcome::Good {
        fingerprint: info.fingerprint.clone(),
        identity: info.addresses.first().cloned(),
        trust: info.trust(),
    }
}

fn hex_upper(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02X}")).collect()
}

impl MailCrypto for PgpKeyring {
    fn handles(&self, kind: CryptoKind) -> bool {
        kind.is_supported()
    }

    fn verify(&self, signed: &[u8], signature: &[u8]) -> VerifyOutcome {
        self.verify_detached(signed, signature)
    }

    fn decrypt(&self, enveloped: &[u8]) -> Result<Zeroizing<Vec<u8>>, DecryptError> {
        self.decrypt_message(enveloped)
    }
}

// ── Pulling the signed bytes out of a multipart/signed ───────────────────────

/// The two children of a root `multipart/<subtype>` (RFC 3156), or `None`.
///
/// **Exactly two**, the second typed `<second_main>/<second_sub>`
/// (`application/pgp-signature`; `application/octet-stream` for the ciphertext).
/// A signature covers children[0] and nothing else, while the reader renders a
/// whole message: a third part (text, HTML, an attachment) appended to one
/// genuine signed mail would sit outside the signature but under its verdict.
/// Any other shape is unusable, never verified.
fn two_part_root(
    msg: &mail_parser::Message<'_>,
    subtype: &str,
    second_main: &str,
    second_sub: &str,
) -> Option<[u32; 2]> {
    use mail_parser::{MimeHeaders, PartType};

    let root = msg.root_part();
    let ctype = root.content_type()?;
    let is_root = ctype.ctype().eq_ignore_ascii_case("multipart")
        && ctype
            .subtype()
            .is_some_and(|s| s.eq_ignore_ascii_case(subtype));
    let PartType::Multipart(ids) = &root.body else {
        return None;
    };
    let [first, second] = ids.as_slice() else {
        return None;
    };
    if !is_root {
        return None;
    }
    let second_type = msg.part(*second)?.content_type()?;
    (second_type.ctype().eq_ignore_ascii_case(second_main)
        && second_type
            .subtype()
            .is_some_and(|s| s.eq_ignore_ascii_case(second_sub)))
    .then_some([*first, *second])
}

/// The exact bytes an RFC 3156 signature covers, and the signature beside them.
///
/// **The single most error-prone function in the feature**, because the failure
/// is silent in the dangerous direction: a verifier fed the wrong bytes reports
/// a *pass* over something the sender never signed. Three rules, all from
/// RFC 3156 §5, and all of them the reason this reads from the **raw message**
/// rather than from anything `mail-parser` decoded:
///
/// 1. The signature covers the first part **including its MIME headers**, not
///    just its body — so a decoded body is the wrong input by construction.
/// 2. It covers the part in its **transfer-encoded** form, byte for byte as it
///    arrived. Decoding base64 and re-encoding it would not reproduce it.
/// 3. Line endings are canonical **CRLF**, and the CRLF immediately before the
///    closing boundary belongs to the boundary, not to the part.
///
/// `mail-parser` records each part's byte offsets in the original message,
/// which is what makes rule 2 achievable at all: the slice is the original
/// bytes, not a re-serialization.
pub fn signed_part_bytes(raw: &[u8], msg: &mail_parser::Message<'_>) -> Option<(Vec<u8>, Vec<u8>)> {
    // The `multipart/signed` node, and its two children in order. The **root**
    // only, matching `mail_crypto::detect`: a signed node nested beside other
    // content covers none of that content, and a signature checked there would
    // lend its verdict to parts the sender never saw.
    let children = two_part_root(msg, "signed", "application", "pgp-signature")?;

    let content = msg.part(children[0])?;
    let signature = msg.part(children[1])?;

    let start = content.offset_header as usize;
    let end = content.offset_end as usize;
    if start >= end || end > raw.len() {
        return None;
    }
    let mut bytes = canonical_crlf(&raw[start..end]);
    // Rule 3: the last CRLF introduces the boundary line and is not part of what
    // was signed. Off by this one sequence and every signature reads as invalid.
    if bytes.ends_with(b"\r\n") {
        bytes.truncate(bytes.len() - 2);
    }

    let sig_start = signature.offset_body as usize;
    let sig_end = signature.offset_end as usize;
    if sig_start >= sig_end || sig_end > raw.len() {
        return None;
    }
    Some((bytes, raw[sig_start..sig_end].to_vec()))
}

/// Verify a `multipart/signed` root and say what the reader may render.
///
/// Returns the panel's verdict and, with a usable shape (exactly two children,
/// the second a signature), the **signed part's own bytes**, children[0]: what a
/// decrypted inner message is to the encrypted arm. The caller parses those in
/// place of the message, so the body, the attachment list, `load_attachment` and
/// the agent's `mail_read` show what the signature covers and nothing beside it.
/// The verdict may be Bad or NoKey; the content is the same narrowed part.
/// Any other shape is `Unusable` with `None`: the whole message stays as it is,
/// and no part of it earns positive chrome.
pub fn check_signed_root(
    ring: &PgpKeyring,
    raw: &[u8],
    msg: &mail_parser::Message<'_>,
    from_address: &str,
) -> (Option<Vec<u8>>, crate::schema::mail::MailCryptoInfo) {
    let (rendered, outcome) = match signed_part_bytes(raw, msg) {
        Some((signed, sig)) => {
            let outcome = ring.verify_detached(&signed, &sig);
            (Some(signed), outcome)
        }
        None => (None, VerifyOutcome::Unusable("signature-structure".into())),
    };
    let info = crate::services::mail_crypto::info_for(
        CryptoKind::PgpSigned,
        Some(&outcome),
        false,
        from_address,
    );
    (rendered, info)
}

/// The ciphertext part of an RFC 3156 `multipart/encrypted` message.
pub fn encrypted_part_bytes(raw: &[u8], msg: &mail_parser::Message<'_>) -> Option<Vec<u8>> {    // The root only, for the reason `signed_part_bytes` gives: a ciphertext
    // nested in someone else's message must not be decrypted into it.
    let children = two_part_root(msg, "encrypted", "application", "octet-stream")?;
    // Part 1 is the `application/pgp-encrypted` version marker; part 2 is the
    // payload. Reading part 1 as the message is the classic mis-slice.
    let payload = msg.part(children[1])?;
    let start = payload.offset_body as usize;
    let end = payload.offset_end as usize;
    (start < end && end <= raw.len()).then(|| raw[start..end].to_vec())
}

/// Normalize line endings to CRLF without doubling an existing one.
fn canonical_crlf(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len() + bytes.len() / 32);
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\r' => {
                out.extend_from_slice(b"\r\n");
                if bytes.get(i + 1) == Some(&b'\n') {
                    i += 1;
                }
            }
            b'\n' => out.extend_from_slice(b"\r\n"),
            b => out.push(b),
        }
        i += 1;
    }
    out
}

// ── Assembling the outgoing shapes ──────────────────────────────────────────

/// A random MIME boundary that cannot occur in the content it delimits.
fn boundary() -> String {
    let mut bytes = [0u8; 18];
    getrandom::fill(&mut bytes).expect("the OS RNG must be available to send mail");
    format!(
        concat!("=_", crate::app_slug!(), "_{}"),
        B64.encode(bytes).replace(['+', '/', '='], "x")
    )
}

/// Wrap `body` (a complete MIME entity: headers + body) as RFC 3156
/// `multipart/signed`.
///
/// `micalg` names the digest so a recipient can pick the hash before parsing the
/// signature. It is the one header here that is a hint rather than a fact, and
/// it is stated correctly rather than omitted, because some clients refuse a
/// `multipart/signed` without one.
pub fn wrap_signed(body: &str, signature: &str) -> (String, String) {
    let b = boundary();
    let content_type =
        format!("multipart/signed; micalg=pgp-sha256; protocol=\"application/pgp-signature\"; boundary=\"{b}\"");
    let mime = format!(
        "--{b}\r\n{body}\r\n--{b}\r\n\
         Content-Type: application/pgp-signature; name=\"signature.asc\"\r\n\
         Content-Description: OpenPGP digital signature\r\n\
         Content-Disposition: attachment; filename=\"signature.asc\"\r\n\r\n\
         {signature}\r\n--{b}--\r\n"
    );
    (content_type, mime)
}

/// Wrap `ciphertext` as RFC 3156 `multipart/encrypted`.
pub fn wrap_encrypted(ciphertext: &str) -> (String, String) {
    let b = boundary();
    let content_type =
        format!("multipart/encrypted; protocol=\"application/pgp-encrypted\"; boundary=\"{b}\"");
    let mime = format!(
        "--{b}\r\n\
         Content-Type: application/pgp-encrypted\r\n\
         Content-Description: PGP/MIME version identification\r\n\r\n\
         Version: 1\r\n\
         --{b}\r\n\
         Content-Type: application/octet-stream; name=\"encrypted.asc\"\r\n\
         Content-Description: OpenPGP encrypted message\r\n\
         Content-Disposition: inline; filename=\"encrypted.asc\"\r\n\r\n\
         {ciphertext}\r\n--{b}--\r\n"
    );
    (content_type, mime)
}

/// What to do to an outgoing message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SealOpts {
    pub sign: bool,
    pub encrypt: bool,
}

impl SealOpts {
    pub fn any(self) -> bool {
        self.sign || self.encrypt
    }
}

impl PgpKeyring {
    /// Turn a fully built plain message into its signed and/or encrypted form.
    ///
    /// **Sign inside, then encrypt** — the standard ordering, and the one that
    /// means something: encrypt-then-sign would let anyone strip the signature
    /// and re-sign the same ciphertext as their own, so the signature would
    /// attest to who *forwarded* the message rather than who wrote it.
    ///
    /// Every failure returns an error. There is deliberately no path where this
    /// gives back the plaintext message because something went wrong — a silent
    /// downgrade to cleartext is the single worst thing an encryption feature
    /// can do, since it looks exactly like success.
    pub fn seal_outgoing(
        &self,
        account_id: &str,
        recipients: &[String],
        message: &[u8],
        opts: SealOpts,
    ) -> Result<Vec<u8>, String> {
        if !opts.any() {
            return Ok(message.to_vec());
        }
        let (outer, inner) =
            split_message(message).ok_or("this message could not be prepared for encryption")?;

        let (mut content_type, mut body) = (String::new(), String::new());
        let mut current = inner;

        if opts.sign {
            // What is signed is the entity as it will appear on the wire, minus
            // the CRLF that introduces the closing boundary — the same slice
            // `signed_part_bytes` reconstructs on the way back in. The two
            // definitions have to agree or nothing we send verifies anywhere,
            // including here.
            let to_sign = trim_trailing_crlf(&current);
            let signature = self.sign_detached(account_id, &to_sign)?;
            let entity = String::from_utf8_lossy(&to_sign).into_owned();
            let (ct, mime) = wrap_signed(&entity, &signature);
            content_type = ct;
            body = mime;
            current = reassemble(b"", &content_type, &body);
            // Strip the header block `reassemble` added: when encryption follows,
            // this whole thing is the *inner* entity and its Content-Type belongs
            // to it, not to the outer message.
            current = current
                .strip_prefix(b"\r\n".as_slice())
                .unwrap_or(&current)
                .to_vec();
        }

        if opts.encrypt {
            let entity = if opts.sign {
                // Rebuild the signed entity with its own content headers so the
                // recipient, after decrypting, sees a complete MIME entity.
                let mut e = Vec::new();
                e.extend_from_slice(b"MIME-Version: 1.0\r\n");
                e.extend_from_slice(format!("Content-Type: {content_type}\r\n\r\n").as_bytes());
                e.extend_from_slice(body.as_bytes());
                e
            } else {
                current.clone()
            };
            let armored = self.encrypt_to(account_id, recipients, &entity)?;
            let (ct, mime) = wrap_encrypted(&armored);
            content_type = ct;
            body = mime;
        }

        Ok(reassemble(&outer, &content_type, &body))
    }
}

fn trim_trailing_crlf(bytes: &[u8]) -> Vec<u8> {
    let mut out = canonical_crlf(bytes);
    while out.ends_with(b"\r\n") {
        out.truncate(out.len() - 2);
    }
    out
}

/// Split a fully built message into its **address headers** and its **content
/// entity**, which is what PGP/MIME needs and what nothing else produces.
///
/// Building the inner entity from scratch was the obvious alternative and is
/// worse: `mail_engine::build_outgoing` already does header-injection rejection,
/// recipient validation, RFC 2047 subject encoding, transfer encoding and
/// attachment assembly, and a second builder written for the encrypted path
/// would be a second set of those decisions to keep in step. So the message is
/// built exactly as an unencrypted one, and then cut in two: `Content-*` and
/// `MIME-Version` describe the *content* and move inside; everything else — From,
/// To, Subject, Date, Message-ID — stays outside.
///
/// **The consequence is worth stating rather than discovering**: the Subject and
/// the recipient list stay in cleartext, because in PGP/MIME they always do.
/// Only the body and its attachments are protected. The UI says so.
///
/// Returns `None` for a message with no header/body separator, which cannot
/// happen for something `build_outgoing` produced and is therefore refused
/// rather than guessed at.
pub fn split_message(raw: &[u8]) -> Option<(Vec<u8>, Vec<u8>)> {
    let sep = find(raw, b"\r\n\r\n")?;
    let (headers, rest) = raw.split_at(sep);
    let body = &rest[4..];

    let mut outer = Vec::new();
    let mut inner = Vec::new();
    // Unfolded logically, not physically: a continuation line belongs to the
    // header above it, and splitting it off would put half a Content-Type in the
    // outer block and the other half in the inner one.
    let mut current: Vec<u8> = Vec::new();
    let mut lines: Vec<Vec<u8>> = Vec::new();
    for line in headers.split(|b| *b == b'\n') {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if line.first().is_some_and(|b| *b == b' ' || *b == b'\t') && !current.is_empty() {
            current.extend_from_slice(b"\r\n");
            current.extend_from_slice(line);
            continue;
        }
        if !current.is_empty() {
            lines.push(std::mem::take(&mut current));
        }
        current = line.to_vec();
    }
    if !current.is_empty() {
        lines.push(current);
    }

    for line in lines {
        let name_end = line.iter().position(|b| *b == b':').unwrap_or(line.len());
        let name = String::from_utf8_lossy(&line[..name_end]).to_ascii_lowercase();
        let target = if name.starts_with("content-") || name == "mime-version" {
            &mut inner
        } else {
            &mut outer
        };
        target.extend_from_slice(&line);
        target.extend_from_slice(b"\r\n");
    }

    inner.extend_from_slice(b"\r\n");
    inner.extend_from_slice(body);
    Some((outer, inner))
}

/// Put an outer header block back together around a new content type and body.
pub fn reassemble(outer_headers: &[u8], content_type: &str, body: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(outer_headers.len() + body.len() + 128);
    out.extend_from_slice(outer_headers);
    out.extend_from_slice(b"MIME-Version: 1.0\r\n");
    out.extend_from_slice(format!("Content-Type: {content_type}\r\n").as_bytes());
    out.extend_from_slice(b"\r\n");
    out.extend_from_slice(body.as_bytes());
    out
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

// ── Helpers ─────────────────────────────────────────────────────────────────

fn parse_secret(entry: &StoredKey) -> Result<SignedSecretKey, String> {
    let material = B64.decode(&entry.material).map_err(|e| e.to_string())?;
    SignedSecretKey::from_bytes(&material[..]).map_err(|e| e.to_string())
}

fn parse_public(entry: &StoredKey) -> Result<SignedPublicKey, String> {
    let material = B64.decode(&entry.material).map_err(|e| e.to_string())?;
    if entry.secret {
        Ok(SignedPublicKey::from(
            SignedSecretKey::from_bytes(&material[..]).map_err(|e| e.to_string())?,
        ))
    } else {
        SignedPublicKey::from_bytes(&material[..]).map_err(|e| e.to_string())
    }
}

/// What a re-import of a held fingerprint keeps of the stored entry.
struct CarriedTrust {
    verified: bool,
    accounts: Vec<String>,
    origin: Option<KeyOrigin>,
}

/// The trust a (re-)import of `fingerprint` with user ids `identities` inherits
/// from the entry already stored, and the notes saying what it lost.
///
/// A new fingerprint inherits nothing and is `Imported`. A held one keeps its
/// flag, its account bindings and its **stored** origin (an old entry's stays
/// absent, so [`origin_of`] still reads it the old way) — but only while its
/// user-id set is unchanged; see [`PgpKeyring::import`].
fn carried_trust(
    file: &KeyringFile,
    fingerprint: &str,
    identities: &[String],
) -> (CarriedTrust, Vec<String>) {
    let Some(prior) = file.entries.iter().find(|e| e.fingerprint == fingerprint) else {
        return (
            CarriedTrust {
                verified: false,
                accounts: Vec::new(),
                origin: Some(KeyOrigin::Imported),
            },
            Vec::new(),
        );
    };
    if same_identities(&prior.identities, identities) {
        return (
            CarriedTrust {
                verified: prior.verified,
                accounts: prior.accounts.clone(),
                origin: prior.origin,
            },
            Vec::new(),
        );
    }
    let mut notes = Vec::new();
    if prior.verified {
        notes.push("identities-changed-unverified".to_string());
    }
    if !prior.accounts.is_empty() {
        notes.push("identities-changed-unbound".to_string());
    }
    (
        CarriedTrust {
            verified: false,
            accounts: Vec::new(),
            origin: prior.origin,
        },
        notes,
    )
}

/// The same set of user ids, whatever their order or repetition.
fn same_identities(a: &[String], b: &[String]) -> bool {
    use std::collections::BTreeSet;
    a.iter().collect::<BTreeSet<_>>() == b.iter().collect::<BTreeSet<_>>()
}

/// Keep the revocations of the copy already held when another copy of the same
/// key replaces it (gap 88). A revocation is permanent, but it is a signature
/// *in* the copy: an older copy made before the owner revoked (a backup, a
/// keyserver, a "here is my key" attachment) carries none, and replacing the
/// stored one with it would bring a revoked key back, with whatever tick the
/// user gave it still on it. So the held key's revocations (of the key, of a
/// subkey, of a user id) are added to the incoming copy, as GnuPG merges them.
/// Their signatures were checked when that copy was imported, against the same
/// primary key (the fingerprint is equal).
fn carry_revocations(
    file: &KeyringFile,
    fingerprint: &str,
    details: &mut pgp::composed::SignedKeyDetails,
    subkeys: Vec<(pgp::types::Fingerprint, &mut Vec<pgp::packet::Signature>)>,
) {
    use pgp::packet::{Signature, SignatureType};

    fn add(into: &mut Vec<Signature>, from: &[Signature], typ: SignatureType) {
        for sig in from.iter().filter(|s| s.typ() == Some(typ)) {
            if !into.contains(sig) {
                into.push(sig.clone());
            }
        }
    }

    let Some(prior) = file.entries.iter().find(|e| e.fingerprint == fingerprint) else {
        return;
    };
    let Ok(old) = parse_public(prior) else {
        return;
    };
    add(
        &mut details.revocation_signatures,
        &old.details.revocation_signatures,
        SignatureType::KeyRevocation,
    );
    for old_user in &old.details.users {
        if let Some(user) = details.users.iter_mut().find(|u| u.id == old_user.id) {
            add(&mut user.signatures, &old_user.signatures, SignatureType::CertRevocation);
        }
    }
    for (fp, sigs) in subkeys {
        if let Some(old_sub) = old.public_subkeys.iter().find(|s| s.key.fingerprint() == fp) {
            add(sigs, &old_sub.signatures, SignatureType::SubkeyRevocation);
        }
    }
}

/// Where `entry` came from. A key an older build stored has no record: a
/// private key counts as imported unless it already has an account binding
/// (the user made that choice under the old rules), and a public key is always
/// somebody else's.
fn origin_of(entry: &StoredKey) -> KeyOrigin {
    match entry.origin {
        Some(o) => o,
        None if entry.secret && !entry.accounts.is_empty() => KeyOrigin::Generated,
        None => KeyOrigin::Imported,
    }
}

/// Builds before the import fix stored every imported private key as
/// Verified, and its user ids are claims like any other key's. Demote each
/// unbound one to Known, once (`secret_trust_migrated` stops a key the user
/// verifies afterwards from being demoted again). Keys of that age have no
/// recorded origin (gap 91), so this also demotes a generated key that a newer
/// one took the account binding from; it shows as Known until checked again.
fn demote_imported_secrets(file: &mut KeyringFile) {
    for e in file.entries.iter_mut() {
        if e.secret && e.verified && e.accounts.is_empty() {
            e.verified = false;
        }
    }
    file.secret_trust_migrated = true;
}

/// One imported key into `file` as `fingerprint`, in place of any entry of
/// that fingerprint, with the trust it carries over ([`carried_trust`]). Only
/// a secret key keeps the carried account bindings. Answers what to report.
fn record_import(
    file: &mut KeyringFile,
    fingerprint: String,
    details: &pgp::composed::SignedKeyDetails,
    algorithm: String,
    material: &[u8],
    secret: bool,
) -> PgpKeyInfo {
    let identities = user_ids_of_details(details);
    let (trust, mut notes) = carried_trust(file, &fingerprint, &identities);
    let entry = StoredKey {
        fingerprint: fingerprint.clone(),
        identities,
        secret,
        verified: trust.verified,
        accounts: if secret { trust.accounts } else { Vec::new() },
        algorithm,
        origin: trust.origin,
        material: B64.encode(material),
    };
    file.entries.retain(|e| e.fingerprint != fingerprint);
    file.entries.push(entry.clone());
    let mut info = info_of(&entry);
    info.notes.append(&mut notes);
    info
}

fn info_of(entry: &StoredKey) -> PgpKeyInfo {
    let (revoked, expired) = parse_public(entry)
        .map(|key| key_status(&key, now_secs()))
        .unwrap_or_default();
    info_with(entry, revoked, expired)
}

fn info_with(entry: &StoredKey, revoked: bool, expired: bool) -> PgpKeyInfo {
    PgpKeyInfo {
        fingerprint: entry.fingerprint.clone(),
        addresses: addresses_of(entry),
        identities: entry.identities.clone(),
        secret: entry.secret,
        verified: entry.verified,
        accounts: entry.accounts.clone(),
        algorithm: entry.algorithm.clone(),
        origin: origin_of(entry),
        revoked,
        expired,
        notes: Vec::new(),
    }
}

fn addresses_of(entry: &StoredKey) -> Vec<String> {
    entry
        .identities
        .iter()
        .filter_map(|u| address_of(u))
        .collect()
}

// ── Revocation and expiry (gap 88) ──────────────────────────────────────────
//
// rPGP 0.20 parses all of it and applies none of it: a `SignedPublicKey` keeps
// the key's revocation signatures (`details.revocation_signatures`), each user
// id's certifications and revocations (`SignedUser.signatures`) and each
// subkey's binding and revocation signatures, and `Signature` reads the
// `KeyExpirationTime` subpacket (`key_expiration_time`) and the creation time.
// `verify_bindings` (run at import) checks that every one of them is a genuine
// signature by the key itself, so a revocation we see here was made by its
// owner. What is missing is the reading, which is this section. Nothing is
// stored: the flags are computed from the key material each time, against the
// clock.

/// A key's state against the clock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Standing {
    Live,
    Expired,
    Revoked,
}

impl Standing {
    fn of(revoked: bool, expired: bool) -> Self {
        if revoked {
            Standing::Revoked
        } else if expired {
            Standing::Expired
        } else {
            Standing::Live
        }
    }
}

fn now_secs() -> u32 {
    pgp::types::Timestamp::now().as_secs()
}

/// When a key or subkey may be used: from its creation to its expiry, and not
/// at all once revoked. Seconds since the epoch.
#[derive(Debug, Clone, Copy)]
struct Window {
    start: u32,
    end: Option<u32>,
    revoked: bool,
}

impl Window {
    /// Whether the key was usable at `t`.
    fn holds_at(&self, t: u32) -> bool {
        !self.revoked && t >= self.start && self.end.is_none_or(|end| t < end)
    }
}

/// The signature made last. Ties and missing times sort first, so a signature
/// whose time cannot be read never outranks one that has it.
fn latest<'a>(
    sigs: impl Iterator<Item = &'a pgp::packet::Signature>,
) -> Option<&'a pgp::packet::Signature> {
    sigs.max_by_key(|s| s.created().map(|t| t.as_secs()).unwrap_or(0))
}

/// The absolute expiry a `KeyExpirationTime` of `d` seconds after `created`
/// gives. Zero means "never", as the RFC has it.
fn expiry_after(created: u32, d: pgp::types::Duration) -> Option<u32> {
    (d.as_secs() != 0).then(|| created.saturating_add(d.as_secs()))
}

/// The primary key's window. The expiry is read the way OpenPGP implementations
/// do: the newest direct-key signature that carries one, else the newest
/// self-certification of the primary user id (or of the first, with none
/// marked primary). A user-id revocation does not count as one.
fn key_window(key: &SignedPublicKey) -> Window {
    window_of(key.primary_key.created_at().as_secs(), &key.details)
}

/// [`key_window`] of a primary key created at `created` with `details`: what a
/// secret key's window is read from too, without making a public copy of it.
fn window_of(created: u32, details: &pgp::composed::SignedKeyDetails) -> Window {
    use pgp::packet::SignatureType;

    // A key whose every user id its owner revoked has withdrawn all its claims.
    let revoked = details
        .revocation_signatures
        .iter()
        .any(|s| s.typ() == Some(SignatureType::KeyRevocation))
        || (!details.users.is_empty() && user_ids_of_details(details).is_empty());

    let direct = latest(
        details
            .direct_signatures
            .iter()
            .filter(|s| s.typ() == Some(SignatureType::Key)),
    )
    .and_then(|s| s.key_expiration_time());

    let expiry = direct.or_else(|| {
        let certs = details.users.iter().filter_map(|u| {
            latest(
                u.signatures
                    .iter()
                    .filter(|s| s.typ() != Some(SignatureType::CertRevocation)),
            )
        });
        let primary = certs
            .clone()
            .filter(|s| s.is_primary())
            .max_by_key(|s| s.created().map(|t| t.as_secs()).unwrap_or(0))
            .or_else(|| certs.clone().next());
        primary.and_then(|s| s.key_expiration_time())
    });
    Window {
        start: created,
        end: expiry.and_then(|d| expiry_after(created, d)),
        revoked,
    }
}

/// Whether a subkey created at `created` with binding `signatures` may be used
/// at `now` under a primary whose window is `primary`: both must hold.
fn subkey_usable(primary: &Window, created: u32, signatures: &[pgp::packet::Signature], now: u32) -> bool {
    primary.holds_at(now) && subkey_window(created, signatures).holds_at(now)
}

/// A subkey's window from its own binding signatures: the newest binding gives
/// the expiry, and any subkey revocation ends it.
fn subkey_window(created: u32, signatures: &[pgp::packet::Signature]) -> Window {
    use pgp::packet::SignatureType;

    let revoked = signatures
        .iter()
        .any(|s| s.typ() == Some(SignatureType::SubkeyRevocation));
    let expiry = latest(
        signatures
            .iter()
            .filter(|s| s.typ() == Some(SignatureType::SubkeyBinding)),
    )
    .and_then(|s| s.key_expiration_time());
    Window {
        start: created,
        end: expiry.and_then(|d| expiry_after(created, d)),
        revoked,
    }
}

/// Whether the key is revoked, and whether its expiry has passed, at `now`.
fn key_status(key: &SignedPublicKey, now: u32) -> (bool, bool) {
    let w = key_window(key);
    (w.revoked, w.end.is_some_and(|end| now >= end))
}

/// The address out of an OpenPGP user id (`Name <a@b>` or a bare address).
///
/// Lowercased, because the alignment check compares mailboxes and a key whose
/// uid spells the address in title case is the same person.
pub fn address_of(uid: &str) -> Option<String> {
    let uid = uid.trim();
    if let (Some(open), Some(close)) = (uid.rfind('<'), uid.rfind('>')) {
        if open < close {
            let inner = uid[open + 1..close].trim();
            if inner.contains('@') {
                return Some(inner.to_ascii_lowercase());
            }
        }
    }
    if uid.contains('@') && !uid.contains(' ') {
        return Some(uid.to_ascii_lowercase());
    }
    None
}

fn user_id_for(name: &str, address: &str) -> String {
    let name = name.trim();
    let address = address.trim();
    if name.is_empty() {
        address.to_string()
    } else {
        format!("{name} <{address}>")
    }
}

/// The key's user ids, **without the ones its owner has revoked**: a revoked id
/// is a claim the owner withdrew, and an address on it must not keep the key
/// eligible for that address. A revocation older than the id's newest
/// certification is a certification that came back and does not count.
fn user_ids_of_details(details: &pgp::composed::SignedKeyDetails) -> Vec<String> {
    use pgp::packet::SignatureType;

    let time = |s: &pgp::packet::Signature| s.created().map(|t| t.as_secs()).unwrap_or(0);
    details
        .users
        .iter()
        .filter(|u| {
            let revoked = latest(
                u.signatures
                    .iter()
                    .filter(|s| s.typ() == Some(SignatureType::CertRevocation)),
            );
            let certified = latest(
                u.signatures
                    .iter()
                    .filter(|s| s.typ() != Some(SignatureType::CertRevocation)),
            );
            match (revoked, certified) {
                (None, _) => true,
                (Some(_), None) => false,
                (Some(r), Some(c)) => time(c) > time(r),
            }
        })
        .map(|u| String::from_utf8_lossy(u.id.id()).into_owned())
        .collect()
}

/// Uppercase hex, no spaces — one spelling everywhere, so a lookup by
/// fingerprint cannot miss because of formatting.
fn fingerprint_hex(fp: &pgp::types::Fingerprint) -> String {
    fp.as_bytes().iter().map(|b| format!("{b:02X}")).collect()
}

/// Accept the forms a user can paste: spaced, lowercase, `0x`-prefixed.
pub fn normalize_fingerprint(s: &str) -> String {
    let s = s.trim().trim_start_matches("0x").trim_start_matches("0X");
    s.chars()
        .filter(|c| c.is_ascii_hexdigit())
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

/// A fingerprint in the form people actually compare: groups of four.
///
/// Reading 40 undifferentiated hex characters aloud is how a fingerprint check
/// becomes a fingerprint glance, so the display form is the grouped one.
pub fn format_fingerprint(fp: &str) -> String {
    let fp = normalize_fingerprint(fp);
    fp.as_bytes()
        .chunks(4)
        .map(|c| String::from_utf8_lossy(c).into_owned())
        .collect::<Vec<_>>()
        .join(" ")
}

fn algorithm_label(alg: pgp::crypto::public_key::PublicKeyAlgorithm) -> String {
    use pgp::crypto::public_key::PublicKeyAlgorithm as A;
    match alg {
        A::RSA | A::RSAEncrypt | A::RSASign => "RSA".into(),
        A::EdDSALegacy | A::Ed25519 => "Curve25519".into(),
        A::ECDH | A::X25519 => "Curve25519".into(),
        other => format!("{other:?}"),
    }
}

/// A v4 Curve25519 key: Ed25519 primary (certify), Ed25519 signing subkey,
/// Curve25519 ECDH encryption subkey.
///
/// The **legacy** v4 forms rather than the RFC 9580 v6 ones, because
/// interoperating with Thunderbird, GnuPG and Outlook is the point of using a
/// standard and v6 support in the wild is not yet there.
fn generate_curve25519(uid: &str) -> Result<SignedSecretKey, String> {
    build_curve25519(uid, None)
}

/// [`generate_curve25519`] with the creation time of the primary and both
/// subkeys given (`None`: now). Production passes none; the tests make keys that
/// were created in the past.
fn build_curve25519(
    uid: &str,
    created_at: Option<pgp::types::Timestamp>,
) -> Result<SignedSecretKey, String> {
    let mut signing = SubkeyParamsBuilder::default();
    signing
        .key_type(KeyType::Ed25519Legacy)
        .can_sign(true)
        .can_encrypt(EncryptionCaps::None)
        .can_authenticate(false);
    let mut encryption = SubkeyParamsBuilder::default();
    encryption
        .key_type(KeyType::ECDH(ECCCurve::Curve25519Legacy))
        .can_sign(false)
        .can_encrypt(EncryptionCaps::All)
        .can_authenticate(false);
    if let Some(at) = created_at {
        signing.created_at(at);
        encryption.created_at(at);
    }

    let mut params = SecretKeyParamsBuilder::default();
    params
        .key_type(KeyType::Ed25519Legacy)
        .can_certify(true)
        .can_sign(false)
        .can_encrypt(EncryptionCaps::None)
        .primary_user_id(uid.to_string())
        .subkeys(vec![
            signing.build().map_err(|e| e.to_string())?,
            encryption.build().map_err(|e| e.to_string())?,
        ]);

    if let Some(at) = created_at {
        params.created_at(at);
    }

    // No passphrase on the key itself. The material is already sealed at rest
    // under the store key, so a second passphrase would protect nothing new and
    // would mean prompting on every signature — which is how signing gets turned
    // off. The store's unlock *is* the keyring's unlock.
    params
        .build()
        .map_err(|e| e.to_string())?
        .generate(rand::rngs::OsRng)
        .map_err(|e| format!("could not generate a key: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::mail_crypt::Key;

    fn keyring() -> (tempfile::TempDir, PgpKeyring) {
        let dir = tempfile::tempdir().unwrap();
        let keys = MailKeys::derive(Key::from_bytes([11u8; 32]));
        let ring = PgpKeyring::open(dir.path(), &keys, *mail_crypt::side_files()).unwrap();
        (dir, ring)
    }

    #[test]
    fn a_generated_key_is_curve25519_and_bound_to_its_account() {
        let (_d, ring) = keyring();
        let info = ring
            .generate("Alice", "alice@example.com", "acct-1")
            .unwrap();
        assert_eq!(info.algorithm, "Curve25519", "RSA must never be generated");
        assert_eq!(info.addresses, vec!["alice@example.com"]);
        assert!(info.secret);
        assert!(
            info.verified,
            "a key we made ourselves needs no out-of-band check"
        );
        assert_eq!(info.accounts, vec!["acct-1"]);
        assert_eq!(info.fingerprint.len(), 40, "v4 fingerprint, uppercase hex");

        assert!(ring.secret_for_account("acct-1").unwrap().is_some());
        assert!(ring.secret_for_account("acct-2").unwrap().is_none());
    }

    #[test]
    fn the_keyring_file_holds_no_readable_key_material() {
        let (dir, ring) = keyring();
        ring.generate("Alice", "alice@example.com", "acct-1")
            .unwrap();
        let raw = std::fs::read(dir.path().join(KEYRING_FILE)).unwrap();
        for probe in [
            &b"alice@example.com"[..],
            b"Alice",
            b"PRIVATE KEY",
            b"fingerprint",
        ] {
            assert!(
                !raw.windows(probe.len()).any(|w| w == probe),
                "{:?} is readable in the keyring file",
                String::from_utf8_lossy(probe)
            );
        }
    }

    #[test]
    fn another_store_key_cannot_open_the_keyring() {
        let dir = tempfile::tempdir().unwrap();
        let ring =
            PgpKeyring::open(dir.path(), &MailKeys::derive(Key::from_bytes([11u8; 32])), *mail_crypt::side_files()).unwrap();
        ring.generate("Alice", "alice@example.com", "a").unwrap();

        let wrong =
            PgpKeyring::open(dir.path(), &MailKeys::derive(Key::from_bytes([12u8; 32])), *mail_crypt::side_files()).unwrap();
        assert!(wrong.list().is_err());
    }

    #[test]
    fn an_imported_public_key_is_known_and_not_verified() {
        // The single most important default in this module. Importing is not
        // checking, and a key that arrives claiming to be someone must not be
        // able to grant itself the chrome that says it is.
        let (_d, source) = keyring();
        source.generate("Bob", "bob@example.org", "acct-b").unwrap();
        let armored = source
            .export_public(&source.list().unwrap()[0].fingerprint)
            .unwrap();

        let (_d2, mine) = keyring();
        let added = mine.import(armored.as_bytes()).unwrap();
        assert_eq!(added.len(), 1);
        assert!(!added[0].secret, "only the public half travelled");
        assert!(
            !added[0].verified,
            "an imported key is Known, never Verified"
        );
        assert_eq!(added[0].trust(), SignerTrust::Known);
        assert_eq!(added[0].addresses, vec!["bob@example.org"]);
    }

    #[test]
    fn verifying_a_fingerprint_is_the_only_promotion() {
        let (_d, source) = keyring();
        source.generate("Bob", "bob@example.org", "b").unwrap();
        let armored = source
            .export_public(&source.list().unwrap()[0].fingerprint)
            .unwrap();

        let (_d2, mine) = keyring();
        let fp = mine.import(armored.as_bytes()).unwrap()[0]
            .fingerprint
            .clone();
        assert_eq!(mine.get(&fp).unwrap().unwrap().trust(), SignerTrust::Known);
        let promoted = mine.set_verified(&fp, true).unwrap();
        assert_eq!(promoted.trust(), SignerTrust::Verified);
        // …and it is reversible, because "I checked this" can turn out to be wrong.
        assert_eq!(
            mine.set_verified(&fp, false).unwrap().trust(),
            SignerTrust::Known
        );
    }

    /// Re-importing the public half of a key whose private half we hold must not
    /// throw the private half away — that would silently disable signing and
    /// decryption for the user's own address.
    #[test]
    fn a_public_import_never_downgrades_a_secret_key() {
        let (_d, ring) = keyring();
        let mine = ring
            .generate("Alice", "alice@example.com", "acct-1")
            .unwrap();
        let armored = ring.export_public(&mine.fingerprint).unwrap();
        ring.import(armored.as_bytes()).ok();

        let back = ring.get(&mine.fingerprint).unwrap().unwrap();
        assert!(
            back.secret,
            "the private half must survive a public re-import"
        );
        assert_eq!(
            back.accounts,
            vec!["acct-1"],
            "and so must its account binding"
        );
        assert!(ring.secret_for_account("acct-1").unwrap().is_some());
    }

    #[test]
    fn one_account_has_exactly_one_key() {
        let (_d, ring) = keyring();
        let a = ring
            .generate("Alice", "alice@example.com", "acct-1")
            .unwrap();
        let b = ring
            .generate("Alice Work", "alice@work.example", "acct-1")
            .unwrap();
        let list = ring.list().unwrap();
        let bound: Vec<&PgpKeyInfo> = list
            .iter()
            .filter(|k| k.accounts.contains(&"acct-1".into()))
            .collect();
        assert_eq!(
            bound.len(),
            1,
            "a second binding would make signing ambiguous"
        );
        assert_eq!(bound[0].fingerprint, b.fingerprint);
        assert!(
            ring.get(&a.fingerprint).unwrap().is_some(),
            "the old key is kept, just unbound"
        );
    }

    #[test]
    fn only_a_key_we_hold_the_private_half_of_can_be_an_identity() {
        let (_d, source) = keyring();
        source.generate("Bob", "bob@example.org", "b").unwrap();
        let armored = source
            .export_public(&source.list().unwrap()[0].fingerprint)
            .unwrap();
        let (_d2, mine) = keyring();
        let fp = mine.import(armored.as_bytes()).unwrap()[0]
            .fingerprint
            .clone();
        let own = vec!["bob@example.org".to_string()];
        assert!(mine
            .bind_account(&fp, "acct-1", true, "bob@example.org", &own, false)
            .is_err());
    }

    #[test]
    fn lookup_by_address_prefers_a_verified_key() {
        let (_d, source) = keyring();
        source.generate("Bob One", "bob@example.org", "b1").unwrap();
        source.generate("Bob Two", "bob@example.org", "b2").unwrap();
        let fps: Vec<String> = source
            .list()
            .unwrap()
            .iter()
            .map(|k| k.fingerprint.clone())
            .collect();

        let (_d2, mine) = keyring();
        for fp in &fps {
            mine.import(source.export_public(fp).unwrap().as_bytes())
                .unwrap();
        }
        mine.set_verified(&fps[1], true).unwrap();
        let (_key, info) = mine.public_for_address("BOB@Example.ORG").unwrap().unwrap();
        assert_eq!(info.fingerprint, fps[1], "the checked key wins");
    }

    /// A transferable secret key someone else made, carrying `uid` — the
    /// "here is my key" file that is really a private key with a borrowed name.
    fn foreign_secret(uid: &str) -> (String, Vec<u8>) {
        let key = generate_curve25519(uid).unwrap();
        (fingerprint_hex(&key.fingerprint()), key.to_bytes().unwrap())
    }

    /// Holding the private half proves nothing about whose the user ids are. An
    /// imported secret key that could grant itself `Verified` would let anyone
    /// who mails the user one sign as anybody, with the only positive chrome.
    #[test]
    fn an_imported_secret_key_is_known_and_its_signatures_earn_no_tick() {
        let (fp, bytes) = foreign_secret("Friend <friend@corp.example>");
        // The attacker signs with it from their own keyring.
        let (_d, attacker) = keyring();
        attacker.import(&bytes).unwrap();
        attacker
            .bind_account(&fp, "evil", true, "friend@corp.example", &["friend@corp.example".into()], true)
            .unwrap();
        let sig = attacker.sign_detached("evil", b"wire the money").unwrap();

        let (_d2, mine) = keyring();
        let added = mine.import(&bytes).unwrap();
        assert_eq!(added.len(), 1);
        assert!(added[0].secret);
        assert!(!added[0].verified, "importing a private key is not checking it");
        assert_eq!(added[0].trust(), SignerTrust::Known);

        let outcome = mine.verify_detached(b"wire the money", sig.as_bytes());
        match &outcome {
            VerifyOutcome::Good { trust, .. } => assert_eq!(*trust, SignerTrust::Known),
            other => panic!("expected Good/Known, got {other:?}"),
        }
        let info = crate::services::mail_crypto::info_for(
            CryptoKind::PgpSigned,
            Some(&outcome),
            false,
            "friend@corp.example",
        );
        assert_ne!(info.state, crate::schema::mail::MailCryptoState::Verified);
    }

    #[test]
    fn an_imported_secret_key_does_not_outrank_the_genuine_key_for_encryption() {
        let (_d, friend) = keyring();
        friend
            .generate("Friend", "friend@corp.example", "f")
            .unwrap();
        let genuine = friend.list().unwrap()[0].fingerprint.clone();
        let (forged, bytes) = foreign_secret("Friend <friend@corp.example>");

        let (_d2, mine) = keyring();
        mine.import(friend.export_public(&genuine).unwrap().as_bytes())
            .unwrap();
        mine.import(&bytes).unwrap();
        // Neither checked: being secret is no reason to win.
        let (_k, info) = mine.public_for_address("friend@corp.example").unwrap().unwrap();
        assert_eq!(info.fingerprint, genuine, "the secret import must not jump the queue");
        // The user checks the genuine one: it wins, whatever order they came in.
        mine.set_verified(&genuine, true).unwrap();
        let (_k, info) = mine.public_for_address("friend@corp.example").unwrap().unwrap();
        assert_eq!(info.fingerprint, genuine);
        assert_ne!(info.fingerprint, forged);
    }

    /// Re-importing must not quietly verify a key the user had un-verified —
    /// the old code replaced the entry with a fresh `verified: true`.
    #[test]
    fn re_importing_a_secret_key_keeps_its_verified_flag() {
        let (fp, bytes) = foreign_secret("Carol <carol@example.org>");
        let (_d, mine) = keyring();
        mine.import(&bytes).unwrap();
        mine.set_verified(&fp, false).unwrap();
        mine.import(&bytes).unwrap();
        assert!(!mine.get(&fp).unwrap().unwrap().verified, "still unverified");

        mine.set_verified(&fp, true).unwrap();
        mine.import(&bytes).unwrap();
        assert!(mine.get(&fp).unwrap().unwrap().verified, "and still verified");
    }

    /// Binding an imported private key to an account is the user naming it their
    /// own identity, after being told what that risks (gap 91); it leaves the key
    /// unverified, the fingerprint tick is the user's own, and unbinding takes
    /// the account, not the trust.
    #[test]
    fn binding_an_imported_secret_key_needs_the_acknowledgement_and_never_verifies_it() {
        let (fp, bytes) = foreign_secret("Alice <alice@example.com>");
        let (_d, mine) = keyring();
        mine.import(&bytes).unwrap();
        assert!(!mine.get(&fp).unwrap().unwrap().verified);
        assert_eq!(mine.get(&fp).unwrap().unwrap().origin, KeyOrigin::Imported);

        let own = vec!["Alice@Example.com".to_string(), "alice@work.example".to_string()];
        let refused = mine
            .bind_account(&fp, "acct-1", true, "ALICE@example.com", &own, false)
            .unwrap_err();
        assert!(refused.contains("imported"), "{refused}");
        assert!(mine.get(&fp).unwrap().unwrap().accounts.is_empty(), "not bound");

        let bound = mine
            .bind_account(&fp, "acct-1", true, "ALICE@example.com", &own, true)
            .unwrap();
        assert!(!bound.verified, "the answer says it is still unverified");
        assert_eq!(bound.notes, vec!["bound-imported-unverified"]);
        let stored = mine.get(&fp).unwrap().unwrap();
        assert!(!stored.verified, "and it is");
        assert_eq!(stored.accounts, vec!["acct-1"]);
        assert!(stored.notes.is_empty(), "a later read carries no notes");

        // The user compares the fingerprint: that is what verifies it.
        mine.set_verified(&fp, true).unwrap();
        mine.bind_account(&fp, "acct-1", false, "", &[], false).unwrap();
        let unbound = mine.get(&fp).unwrap().unwrap();
        assert!(unbound.accounts.is_empty());
        assert!(unbound.verified, "unbinding does not demote");
    }

    /// A key made here is the one binding still verifies, with no confirm: the
    /// user watched it being made.
    #[test]
    fn binding_a_key_generated_here_still_verifies_without_the_acknowledgement() {
        let (_d, mine) = keyring();
        let first = mine.generate("Alice", "alice@example.com", "acct-1").unwrap();
        assert_eq!(first.origin, KeyOrigin::Generated);
        let second = mine.generate("Alice", "alice@example.com", "acct-2").unwrap();
        mine.set_verified(&second.fingerprint, false).unwrap();
        let own = vec!["alice@example.com".to_string()];
        let bound = mine
            .bind_account(&second.fingerprint, "acct-2", true, "alice@example.com", &own, false)
            .unwrap();
        assert!(bound.verified);
        assert!(bound.notes.is_empty());
    }

    /// Keyrings written before the origin was recorded: a private key counts as
    /// imported unless it was already bound, and the stored file stays readable.
    #[test]
    fn an_entry_without_an_origin_is_read_the_old_way() {
        let (_d, mine) = keyring();
        let bound = mine.generate("Alice", "alice@example.com", "acct-1").unwrap();
        let (loose, bytes) = foreign_secret("Bob <bob@example.org>");
        mine.import(&bytes).unwrap();
        let mut file = mine.read().unwrap();
        for e in file.entries.iter_mut() {
            e.origin = None;
        }
        mine.write(&file).unwrap();
        // The field is simply absent on disk, as in an older file.
        let json = serde_json::to_string(&mine.read().unwrap()).unwrap();
        assert!(!json.contains("origin"), "{json}");
        let again: KeyringFile = serde_json::from_str(&json).unwrap();
        assert!(again.entries.iter().all(|e| e.origin.is_none()));

        assert_eq!(mine.get(&bound.fingerprint).unwrap().unwrap().origin, KeyOrigin::Generated);
        assert_eq!(mine.get(&loose).unwrap().unwrap().origin, KeyOrigin::Imported);
        let own = vec!["bob@example.org".to_string()];
        assert!(mine
            .bind_account(&loose, "acct-2", true, "bob@example.org", &own, false)
            .is_err());
    }

    /// Re-importing a held fingerprint keeps what was stored: an imported key is
    /// not turned into a generated one, nor the reverse.
    #[test]
    fn a_re_import_keeps_the_stored_origin() {
        let (_d, mine) = keyring();
        let made = mine.generate("Alice", "alice@example.com", "acct-1").unwrap();
        // The user's own key, imported back from a backup.
        let mut file = mine.read().unwrap();
        let material = B64.decode(&file.entries[0].material).unwrap();
        mine.import(&material).unwrap();
        file = mine.read().unwrap();
        assert_eq!(file.entries[0].origin, Some(KeyOrigin::Generated));
        assert_eq!(mine.get(&made.fingerprint).unwrap().unwrap().origin, KeyOrigin::Generated);
        assert_eq!(
            mine.get(&made.fingerprint).unwrap().unwrap().accounts,
            vec!["acct-1"],
            "same user ids: the binding stays"
        );
    }

    /// The one-click path: a planted key naming a friend must not become an
    /// account's identity (and so Verified) because the user pressed "Use for
    /// this account" beside it.
    #[test]
    fn a_key_that_does_not_name_the_account_address_cannot_be_bound() {
        let (fp, bytes) = foreign_secret("Friend <friend@corp.example>");
        let (_d, mine) = keyring();
        mine.import(&bytes).unwrap();
        let own = vec!["me@example.com".to_string()];
        assert!(mine
            .bind_account(&fp, "acct-1", true, "me@example.com", &own, false)
            .is_err());
        let after = mine.get(&fp).unwrap().unwrap();
        assert!(after.accounts.is_empty(), "not bound");
        assert!(!after.verified, "and not verified");
    }

    /// A key naming the user *and* somebody else, in whatever order the
    /// attacker chose, may sign for the user's account — but binding it must not
    /// vouch for the other address.
    #[test]
    fn binding_a_key_with_a_foreign_user_id_does_not_verify_it() {
        let mut params = SecretKeyParamsBuilder::default();
        params
            .key_type(KeyType::Ed25519Legacy)
            .can_certify(true)
            .can_sign(true)
            .can_encrypt(EncryptionCaps::None)
            .primary_user_id("Friend <friend@corp.example>".into())
            .user_ids(vec!["Me <me@example.com>".into()]);
        let key = params
            .build()
            .unwrap()
            .generate(rand::rngs::OsRng)
            .unwrap();
        let fp = fingerprint_hex(&key.fingerprint());

        let (_d, mine) = keyring();
        mine.import(&key.to_bytes().unwrap()).unwrap();
        let own = vec!["me@example.com".to_string()];
        mine.bind_account(&fp, "acct-1", true, "me@example.com", &own, true)
            .unwrap();
        let after = mine.get(&fp).unwrap().unwrap();
        assert_eq!(after.accounts, vec!["acct-1"], "bound: it does name the account");
        assert!(!after.verified, "but friend@corp.example is not ours to vouch for");
        assert_eq!(after.trust(), SignerTrust::Known);
    }

    /// Keyrings written before the import fix hold imported private keys as
    /// Verified. The first read demotes the unbound ones, once.
    #[test]
    fn old_imported_secret_keys_are_demoted_once() {
        let (_d, mine) = keyring();
        let generated = mine.generate("Alice", "alice@example.com", "acct-1").unwrap();
        let (imported, bytes) = foreign_secret("Friend <friend@corp.example>");
        mine.import(&bytes).unwrap();
        // What an older build left behind: the import Verified, no marker.
        let mut file = mine.read().unwrap();
        assert!(file.secret_trust_migrated, "a fresh keyring needs no migration");
        file.entries
            .iter_mut()
            .find(|e| e.fingerprint == imported)
            .unwrap()
            .verified = true;
        file.secret_trust_migrated = false;
        mine.write(&file).unwrap();

        assert!(
            !mine.get(&imported).unwrap().unwrap().verified,
            "an unbound private key is demoted"
        );
        assert!(
            mine.get(&generated.fingerprint).unwrap().unwrap().verified,
            "a bound one keeps its trust"
        );
        assert!(mine.read().unwrap().secret_trust_migrated, "and the marker is written back");

        // The user checks it by hand afterwards: that sticks.
        mine.set_verified(&imported, true).unwrap();
        assert!(mine.get(&imported).unwrap().unwrap().verified);
    }

    #[test]
    fn deleting_a_key_removes_it() {
        let (_d, ring) = keyring();
        let info = ring.generate("Alice", "alice@example.com", "a").unwrap();
        ring.delete(&info.fingerprint).unwrap();
        assert!(ring.list().unwrap().is_empty());
        assert!(
            ring.delete(&info.fingerprint).is_err(),
            "twice is an error, not a no-op"
        );
    }

    #[test]
    fn fingerprints_normalize_from_every_form_a_user_can_paste() {
        let canonical = "ABCD1234ABCD1234ABCD1234ABCD1234ABCD1234";
        for form in [
            "abcd1234abcd1234abcd1234abcd1234abcd1234",
            "0xABCD1234ABCD1234ABCD1234ABCD1234ABCD1234",
            "ABCD 1234 ABCD 1234  ABCD 1234 ABCD 1234 ABCD 1234",
        ] {
            assert_eq!(normalize_fingerprint(form), canonical);
        }
        assert_eq!(
            format_fingerprint(canonical),
            "ABCD 1234 ABCD 1234 ABCD 1234 ABCD 1234 ABCD 1234",
            "shown in groups, because 40 run-together hex characters do not get compared"
        );
    }

    // ── Verify / decrypt / encrypt ──────────────────────────────────────────

    #[test]
    fn a_signature_round_trips_and_reports_the_signer() {
        let (_d, ring) = keyring();
        let me = ring
            .generate("Alice", "alice@example.com", "acct-1")
            .unwrap();
        let body = b"Content-Type: text/plain\r\n\r\nthe signed body\r\n";

        let sig = ring.sign_detached("acct-1", body).unwrap();
        match ring.verify_detached(body, sig.as_bytes()) {
            VerifyOutcome::Good {
                fingerprint,
                identity,
                trust,
            } => {
                assert_eq!(fingerprint, me.fingerprint);
                assert_eq!(identity.as_deref(), Some("alice@example.com"));
                assert_eq!(trust, SignerTrust::Verified);
            }
            other => panic!("expected a good signature, got {other:?}"),
        }
    }

    /// The property the whole feature rests on: change one byte of the body and
    /// the signature must fail. A verifier that passes here is worse than none.
    #[test]
    fn a_signature_does_not_survive_a_changed_body() {
        let (_d, ring) = keyring();
        ring.generate("Alice", "alice@example.com", "acct-1")
            .unwrap();
        let sig = ring.sign_detached("acct-1", b"pay Bob 100").unwrap();
        assert_eq!(
            ring.verify_detached(b"pay Bob 900", sig.as_bytes()),
            VerifyOutcome::Bad
        );
    }

    /// A signature from a key we do not hold is *unknown*, never *bad*. The two
    /// look identical from here and mean opposite things to a reader.
    #[test]
    fn a_signature_from_an_unknown_key_is_not_reported_as_forged() {
        let (_d, stranger) = keyring();
        stranger.generate("Eve", "eve@example.net", "x").unwrap();
        let sig = stranger.sign_detached("x", b"hello").unwrap();

        let (_d2, mine) = keyring();
        assert!(matches!(
            mine.verify_detached(b"hello", sig.as_bytes()),
            VerifyOutcome::NoKey { .. }
        ));
    }

    /// An imported signer key is `Known`, so a genuine signature from it must
    /// come back `Known` too — the panel's chrome rule depends on this
    /// propagating rather than being decided at the panel.
    #[test]
    fn trust_travels_from_the_keyring_into_the_outcome() {
        let (_d, sender) = keyring();
        sender.generate("Bob", "bob@example.org", "b").unwrap();
        let fp = sender.list().unwrap()[0].fingerprint.clone();
        let armored = sender.export_public(&fp).unwrap();
        let sig = sender.sign_detached("b", b"hello").unwrap();

        let (_d2, mine) = keyring();
        mine.import(armored.as_bytes()).unwrap();
        match mine.verify_detached(b"hello", sig.as_bytes()) {
            VerifyOutcome::Good { trust, .. } => assert_eq!(trust, SignerTrust::Known),
            other => panic!("expected Good/Known, got {other:?}"),
        }
        mine.set_verified(&fp, true).unwrap();
        match mine.verify_detached(b"hello", sig.as_bytes()) {
            VerifyOutcome::Good { trust, .. } => assert_eq!(trust, SignerTrust::Verified),
            other => panic!("expected Good/Verified, got {other:?}"),
        }
    }

    #[test]
    fn a_message_encrypted_to_a_correspondent_round_trips_for_both_of_us() {
        // Two keyrings, as two people: the sender holds their own key and the
        // recipient's public half, and nothing else.
        let (_d1, bob) = keyring();
        bob.generate("Bob", "bob@example.org", "acct-b").unwrap();
        let bob_pub = bob
            .export_public(&bob.list().unwrap()[0].fingerprint)
            .unwrap();

        let (_d2, alice) = keyring();
        alice
            .generate("Alice", "alice@example.com", "acct-a")
            .unwrap();
        alice.import(bob_pub.as_bytes()).unwrap();
        let alice_pub = alice
            .export_public(
                &alice
                    .list()
                    .unwrap()
                    .iter()
                    .find(|k| k.secret)
                    .unwrap()
                    .fingerprint,
            )
            .unwrap();
        bob.import(alice_pub.as_bytes()).unwrap();

        let armored = alice
            .encrypt_to("acct-a", &["bob@example.org".into()], b"the secret")
            .unwrap();
        assert!(armored.starts_with("-----BEGIN PGP MESSAGE-----"));

        assert_eq!(
            bob.decrypt_message(armored.as_bytes()).unwrap().as_slice(),
            b"the secret"
        );
        // The encrypt-to-self half: without it a sent message is one the sender
        // can never read again, and phase 8's Sent copy would be unopenable.
        assert_eq!(
            alice
                .decrypt_message(armored.as_bytes())
                .unwrap()
                .as_slice(),
            b"the secret"
        );
    }

    #[test]
    fn a_third_party_cannot_read_it() {
        let (_d1, bob) = keyring();
        bob.generate("Bob", "bob@example.org", "b").unwrap();
        let bob_pub = bob
            .export_public(&bob.list().unwrap()[0].fingerprint)
            .unwrap();
        let (_d2, alice) = keyring();
        alice.generate("Alice", "alice@example.com", "a").unwrap();
        alice.import(bob_pub.as_bytes()).unwrap();
        let armored = alice
            .encrypt_to("a", &["bob@example.org".into()], b"the secret")
            .unwrap();

        let (_d3, eve) = keyring();
        eve.generate("Eve", "eve@example.net", "e").unwrap();
        assert_eq!(
            eve.decrypt_message(armored.as_bytes()),
            Err(DecryptError::Failed)
        );
    }

    /// Refusing is the feature. Silently dropping a recipient, or falling back
    /// to plaintext, are the two ways an encryption feature betrays its user.
    #[test]
    fn encrypting_refuses_rather_than_dropping_a_keyless_recipient() {
        let (_d, ring) = keyring();
        ring.generate("Alice", "alice@example.com", "a").unwrap();
        let err = ring
            .encrypt_to("a", &["nobody@example.net".into()], b"x")
            .unwrap_err();
        assert!(
            err.contains("nobody@example.net"),
            "the error must name who: {err}"
        );
    }

    #[test]
    fn decrypting_with_no_key_at_all_says_so_rather_than_failing_opaquely() {
        let (_d, empty) = keyring();
        assert_eq!(
            empty.decrypt_message(b"-----BEGIN PGP MESSAGE-----\nx\n-----END PGP MESSAGE-----\n"),
            Err(DecryptError::NoKey)
        );
    }

    // ── Pulling the signed bytes out of a multipart/signed ──────────────────

    /// The canonicalization that decides whether every signature in the app
    /// verifies or none of them do.
    #[test]
    fn the_signed_slice_is_the_part_with_its_headers_and_no_trailing_crlf() {
        let raw = concat!(
            "From: a@example.com\r\n",
            "Content-Type: multipart/signed; protocol=\"application/pgp-signature\"; ",
            "micalg=pgp-sha256; boundary=\"BB\"\r\n",
            "\r\n",
            "--BB\r\n",
            "Content-Type: text/plain\r\n",
            "\r\n",
            "hello\r\n",
            "--BB\r\n",
            "Content-Type: application/pgp-signature\r\n",
            "\r\n",
            "SIGNATURE-BYTES\r\n",
            "--BB--\r\n",
        );
        let msg = mail_parser::MessageParser::default()
            .parse(raw.as_bytes())
            .unwrap();
        let (signed, sig) = signed_part_bytes(raw.as_bytes(), &msg).unwrap();

        let text = String::from_utf8(signed).unwrap();
        assert!(
            text.starts_with("Content-Type: text/plain"),
            "headers are covered: {text:?}"
        );
        assert!(
            text.ends_with("hello"),
            "the CRLF before the boundary is not: {text:?}"
        );
        assert!(String::from_utf8_lossy(&sig).contains("SIGNATURE-BYTES"));
    }

    // ── Gap 75: only the signed part is shown under a signed verdict ────────

    /// Parse a message and run [`check_signed_root`] over it.
    fn check(
        ring: &PgpKeyring,
        raw: &str,
        from: &str,
    ) -> (Option<Vec<u8>>, crate::schema::mail::MailCryptoInfo) {
        let msg = mail_parser::MessageParser::default()
            .parse(raw.as_bytes())
            .unwrap();
        check_signed_root(ring, raw.as_bytes(), &msg, from)
    }

    /// A genuine signed mail from `alice@example.com`, its closing boundary
    /// replaced by `extra` (more parts) and then the boundary again.
    fn signed_mail_with(ring: &PgpKeyring, extra: &str) -> String {
        let body = "Content-Type: text/plain; charset=utf-8\r\n\r\nthe signed words";
        let sig = ring.sign_detached("acct-1", body.as_bytes()).unwrap();
        let (ctype, mime) = wrap_signed(body, &sig);
        let b = ctype.split("boundary=\"").nth(1).unwrap().trim_end_matches('"');
        let closing = format!("--{b}--\r\n");
        assert!(mime.ends_with(&closing));
        let mime = mime.trim_end_matches(&closing).to_string()
            + &extra.replace("{b}", b)
            + &closing;
        format!("From: alice@example.com\r\nContent-Type: {ctype}\r\n\r\n{mime}")
    }

    fn verified_alice() -> (tempfile::TempDir, PgpKeyring) {
        let (d, ring) = keyring();
        let info = ring
            .generate("Alice", "alice@example.com", "acct-1")
            .unwrap();
        ring.set_verified(&info.fingerprint, true).unwrap();
        (d, ring)
    }

    const UNSIGNED_EXTRAS: &str = concat!(
        "--{b}\r\nContent-Type: text/html\r\n\r\n<b>UNSIGNED HTML</b>\r\n",
        "--{b}\r\nContent-Type: application/pdf; name=\"x.pdf\"\r\n",
        "Content-Disposition: attachment; filename=\"x.pdf\"\r\n\r\nPDF\r\n",
    );

    #[test]
    fn a_genuine_two_part_signed_mail_is_verified_and_narrowed_to_the_signed_part() {
        use crate::schema::mail::MailCryptoState;
        let (_d, ring) = verified_alice();
        let raw = signed_mail_with(&ring, "");
        let (shown, info) = check(&ring, &raw, "alice@example.com");
        assert_eq!(info.state, MailCryptoState::Verified);
        let shown = shown.expect("a usable signed root renders its signed part");
        let parsed = crate::services::mail_engine::parse_message(&shown).unwrap();
        assert_eq!(parsed.text.as_deref(), Some("the signed words"));
        assert!(
            parsed.attachments.is_empty(),
            "the signature part is not an attachment of what was signed"
        );
    }

    /// The attack: one genuine signed mail with parts added outside the
    /// signature. Before the fix this stayed Verified and showed the extras.
    #[test]
    fn a_third_part_beside_a_valid_signature_is_unusable_and_never_verified() {
        use crate::schema::mail::MailCryptoState;
        let (_d, ring) = verified_alice();
        let raw = signed_mail_with(&ring, UNSIGNED_EXTRAS);

        // The parser merges the extra leaves into the body lists and the
        // attachment list of the message, which is what the pane used to show.
        let whole = crate::services::mail_engine::parse_message(raw.as_bytes()).unwrap();
        assert!(whole.attachments.iter().any(|a| a.meta.filename == "x.pdf"));

        let (shown, info) = check(&ring, &raw, "alice@example.com");
        assert_eq!(info.state, MailCryptoState::Unusable);
        assert_ne!(info.state, MailCryptoState::Verified);
        assert!(shown.is_none(), "no narrowing for a shape with no verdict");
    }

    #[test]
    fn a_bad_signature_never_gets_the_verified_chip_and_still_shows_only_the_signed_part() {
        use crate::schema::mail::MailCryptoState;
        let (_d, ring) = verified_alice();
        // Tampered after signing: the signed part no longer matches.
        let raw = signed_mail_with(&ring, "").replace("the signed words", "the forged words");
        let (shown, info) = check(&ring, &raw, "alice@example.com");
        assert_eq!(info.state, MailCryptoState::Invalid);
        let shown = String::from_utf8(shown.unwrap()).unwrap();
        assert!(shown.contains("forged words") && !shown.contains("pgp-signature"));
    }

    #[test]
    fn the_second_part_must_be_the_signature_and_the_encrypted_one_octet_stream() {
        let signed = |second: &str| {
            format!(
                concat!(
                    "From: a@example.com\r\n",
                    "Content-Type: multipart/signed; protocol=\"application/pgp-signature\"; boundary=\"BB\"\r\n\r\n",
                    "--BB\r\nContent-Type: text/plain\r\n\r\nhi\r\n",
                    "--BB\r\nContent-Type: {}\r\n\r\nSIG\r\n--BB--\r\n"
                ),
                second
            )
        };
        let parse = |raw: &str| signed_part_bytes(raw.as_bytes(), &mail_parser::MessageParser::default().parse(raw.as_bytes()).unwrap());
        assert!(parse(&signed("application/pgp-signature")).is_some());
        assert!(parse(&signed("APPLICATION/PGP-SIGNATURE; name=s.asc")).is_some());
        assert!(parse(&signed("text/html")).is_none(), "a second part that is not a signature");
        assert!(parse(&signed("application/pdf")).is_none());

        let enc = |second: &str, extra: &str| {
            format!(
                concat!(
                    "From: a@example.com\r\n",
                    "Content-Type: multipart/encrypted; protocol=\"application/pgp-encrypted\"; boundary=\"BB\"\r\n\r\n",
                    "--BB\r\nContent-Type: application/pgp-encrypted\r\n\r\nVersion: 1\r\n",
                    "--BB\r\nContent-Type: {}\r\n\r\nCIPHER\r\n{}--BB--\r\n"
                ),
                second, extra
            )
        };
        let payload = |raw: &str| encrypted_part_bytes(raw.as_bytes(), &mail_parser::MessageParser::default().parse(raw.as_bytes()).unwrap());
        assert!(payload(&enc("application/octet-stream", "")).is_some());
        assert!(payload(&enc("text/plain", "")).is_none());
        assert!(
            payload(&enc("application/octet-stream", "--BB\r\nContent-Type: text/html\r\n\r\n<b>x</b>\r\n")).is_none(),
            "a part beside the ciphertext"
        );
    }

    /// A message whose parts are separated by bare LF — routine after an MTA
    /// rewrite — must canonicalize to the same CRLF form the sender signed.
    #[test]
    fn bare_lf_is_canonicalized_to_crlf() {
        assert_eq!(canonical_crlf(b"a\nb\n"), b"a\r\nb\r\n");
        assert_eq!(
            canonical_crlf(b"a\r\nb\r\n"),
            b"a\r\nb\r\n",
            "and CRLF is not doubled"
        );
        assert_eq!(canonical_crlf(b"a\rb"), b"a\r\nb", "a lone CR too");
    }

    #[test]
    fn the_encrypted_payload_is_the_second_part_not_the_version_marker() {
        let raw = concat!(
            "From: a@example.com\r\n",
            "Content-Type: multipart/encrypted; protocol=\"application/pgp-encrypted\"; ",
            "boundary=\"BB\"\r\n",
            "\r\n",
            "--BB\r\n",
            "Content-Type: application/pgp-encrypted\r\n",
            "\r\n",
            "Version: 1\r\n",
            "--BB\r\n",
            "Content-Type: application/octet-stream\r\n",
            "\r\n",
            "CIPHERTEXT\r\n",
            "--BB--\r\n",
        );
        let msg = mail_parser::MessageParser::default()
            .parse(raw.as_bytes())
            .unwrap();
        let payload = encrypted_part_bytes(raw.as_bytes(), &msg).unwrap();
        let text = String::from_utf8_lossy(&payload);
        assert!(text.contains("CIPHERTEXT"));
        assert!(
            !text.contains("Version: 1"),
            "the version marker is not the message"
        );
    }

    /// The wrappers have to produce something `detect` reads back as what it is
    /// — otherwise we send mail our own client would not recognize.
    #[test]
    fn what_we_wrap_is_what_detection_reads_back() {
        let (ctype, mime) = wrap_signed(
            "Content-Type: text/plain\r\n\r\nhi",
            "-----BEGIN PGP SIGNATURE-----",
        );
        let raw = format!("From: a@example.com\r\nContent-Type: {ctype}\r\n\r\n{mime}");
        let msg = mail_parser::MessageParser::default()
            .parse(raw.as_bytes())
            .unwrap();
        assert_eq!(
            crate::services::mail_crypto::detect(&msg),
            Some(CryptoKind::PgpSigned)
        );

        let (ctype, mime) =
            wrap_encrypted("-----BEGIN PGP MESSAGE-----\nx\n-----END PGP MESSAGE-----");
        let raw = format!("From: a@example.com\r\nContent-Type: {ctype}\r\n\r\n{mime}");
        let msg = mail_parser::MessageParser::default()
            .parse(raw.as_bytes())
            .unwrap();
        assert_eq!(
            crate::services::mail_crypto::detect(&msg),
            Some(CryptoKind::PgpEncrypted)
        );
    }

    /// End to end: sign, wrap, parse the wrapped message back, pull the signed
    /// bytes out of it and verify. This is the one test that would catch a
    /// canonicalization mistake, because every other signature test feeds the
    /// verifier the same buffer the signer saw.
    #[test]
    fn a_wrapped_signed_message_verifies_after_a_round_trip_through_mime() {
        let (_d, ring) = keyring();
        ring.generate("Alice", "alice@example.com", "acct-1")
            .unwrap();

        let body = "Content-Type: text/plain; charset=utf-8\r\n\r\nthe body of the mail\r\n";
        // Sign exactly what the wrapper will emit, minus the CRLF that
        // introduces the boundary — which is what `signed_part_bytes` strips.
        let to_sign = body.trim_end_matches("\r\n");
        let sig = ring.sign_detached("acct-1", to_sign.as_bytes()).unwrap();
        let (ctype, mime) = wrap_signed(body.trim_end_matches("\r\n"), &sig);
        let raw = format!("From: alice@example.com\r\nContent-Type: {ctype}\r\n\r\n{mime}");

        let msg = mail_parser::MessageParser::default()
            .parse(raw.as_bytes())
            .unwrap();
        let (signed, signature) = signed_part_bytes(raw.as_bytes(), &msg).unwrap();
        assert!(
            matches!(
                ring.verify_detached(&signed, &signature),
                VerifyOutcome::Good { .. }
            ),
            "the bytes pulled back out must be the bytes that were signed"
        );
    }

    // ── Assembling an outgoing message ──────────────────────────────────────

    const PLAIN: &[u8] = b"From: Alice <alice@example.com>\r\n\
        To: bob@example.org\r\n\
        Subject: quarterly numbers\r\n\
        Date: Mon, 28 Jul 2026 10:00:00 +0000\r\n\
        MIME-Version: 1.0\r\n\
        Content-Type: text/plain; charset=utf-8\r\n\
        \r\n\
        the body\r\n";

    #[test]
    fn splitting_puts_content_headers_inside_and_address_headers_outside() {
        let (outer, inner) = split_message(PLAIN).unwrap();
        let outer = String::from_utf8(outer).unwrap();
        let inner = String::from_utf8(inner).unwrap();

        assert!(outer.contains("From: Alice"));
        assert!(outer.contains("Subject: quarterly numbers"));
        assert!(
            !outer.contains("Content-Type"),
            "content headers move inside"
        );

        assert!(inner.starts_with("MIME-Version: 1.0\r\nContent-Type: text/plain"));
        assert!(inner.ends_with("the body\r\n"));
    }

    /// A folded header must not be cut in half by the split — that would put
    /// `Content-Type: multipart/mixed;` outside and ` boundary="x"` inside.
    #[test]
    fn a_folded_header_stays_whole() {
        let raw = b"From: a@example.com\r\n\
            Content-Type: multipart/mixed;\r\n\tboundary=\"BB\"\r\n\
            \r\nbody\r\n";
        let (outer, inner) = split_message(raw).unwrap();
        assert!(!String::from_utf8_lossy(&outer).contains("boundary"));
        assert!(String::from_utf8_lossy(&inner).contains("boundary=\"BB\""));
    }

    #[test]
    fn a_signed_message_keeps_its_addresses_and_verifies_end_to_end() {
        let (_d, ring) = keyring();
        ring.generate("Alice", "alice@example.com", "acct-1")
            .unwrap();

        let sealed = ring
            .seal_outgoing(
                "acct-1",
                &["bob@example.org".into()],
                PLAIN,
                SealOpts {
                    sign: true,
                    encrypt: false,
                },
            )
            .unwrap();
        let text = String::from_utf8_lossy(&sealed);
        assert!(
            text.contains("Subject: quarterly numbers"),
            "headers survive"
        );
        assert!(text.contains("multipart/signed"));

        let msg = mail_parser::MessageParser::default()
            .parse(&sealed)
            .unwrap();
        assert_eq!(
            crate::services::mail_crypto::detect(&msg),
            Some(CryptoKind::PgpSigned)
        );
        let (signed, signature) = signed_part_bytes(&sealed, &msg).unwrap();
        assert!(
            matches!(
                ring.verify_detached(&signed, &signature),
                VerifyOutcome::Good { .. }
            ),
            "a message we sealed must verify when read back"
        );
    }

    #[test]
    fn an_encrypted_message_hides_the_body_but_not_the_subject() {
        let (_d1, bob) = keyring();
        bob.generate("Bob", "bob@example.org", "b").unwrap();
        let bob_pub = bob
            .export_public(&bob.list().unwrap()[0].fingerprint)
            .unwrap();
        let (_d2, alice) = keyring();
        alice.generate("Alice", "alice@example.com", "a").unwrap();
        alice.import(bob_pub.as_bytes()).unwrap();

        let sealed = alice
            .seal_outgoing(
                "a",
                &["bob@example.org".into()],
                PLAIN,
                SealOpts {
                    sign: false,
                    encrypt: true,
                },
            )
            .unwrap();
        let text = String::from_utf8_lossy(&sealed);
        assert!(!text.contains("the body"), "the body is gone");
        // Stated rather than discovered: PGP/MIME never hides these.
        assert!(text.contains("Subject: quarterly numbers"));
        assert!(text.contains("To: bob@example.org"));

        let msg = mail_parser::MessageParser::default()
            .parse(&sealed)
            .unwrap();
        assert_eq!(
            crate::services::mail_crypto::detect(&msg),
            Some(CryptoKind::PgpEncrypted)
        );
        let payload = encrypted_part_bytes(&sealed, &msg).unwrap();
        let plain = bob.decrypt_message(&payload).unwrap();
        assert!(String::from_utf8_lossy(&plain).contains("the body"));
    }

    /// Sign-then-encrypt, and the signature must still check out **after**
    /// decryption. The other ordering would let anyone strip the signature and
    /// re-sign the same ciphertext as their own.
    #[test]
    fn signing_happens_inside_the_encryption() {
        let (_d1, bob) = keyring();
        bob.generate("Bob", "bob@example.org", "b").unwrap();
        let bob_pub = bob
            .export_public(&bob.list().unwrap()[0].fingerprint)
            .unwrap();
        let (_d2, alice) = keyring();
        let alice_key = alice.generate("Alice", "alice@example.com", "a").unwrap();
        alice.import(bob_pub.as_bytes()).unwrap();
        bob.import(
            alice
                .export_public(&alice_key.fingerprint)
                .unwrap()
                .as_bytes(),
        )
        .unwrap();

        let sealed = alice
            .seal_outgoing(
                "a",
                &["bob@example.org".into()],
                PLAIN,
                SealOpts {
                    sign: true,
                    encrypt: true,
                },
            )
            .unwrap();
        let outer = mail_parser::MessageParser::default()
            .parse(&sealed)
            .unwrap();
        assert_eq!(
            crate::services::mail_crypto::detect(&outer),
            Some(CryptoKind::PgpEncrypted),
            "the outside is encrypted, not signed"
        );

        let payload = encrypted_part_bytes(&sealed, &outer).unwrap();
        let plain = bob.decrypt_message(&payload).unwrap();
        let inner = mail_parser::MessageParser::default()
            .parse(&plain[..])
            .unwrap();
        assert_eq!(
            crate::services::mail_crypto::detect(&inner),
            Some(CryptoKind::PgpSigned),
            "the signature is inside, where it attests to the author"
        );
        let (signed, signature) = signed_part_bytes(&plain, &inner).unwrap();
        match bob.verify_detached(&signed, &signature) {
            VerifyOutcome::Good { identity, .. } => {
                assert_eq!(identity.as_deref(), Some("alice@example.com"))
            }
            other => panic!("expected Alice's signature, got {other:?}"),
        }
    }

    /// The refusal that makes the feature trustworthy: a missing recipient key
    /// is an error, never a quiet fall back to sending in the clear.
    #[test]
    fn sealing_never_degrades_to_plaintext() {
        let (_d, ring) = keyring();
        ring.generate("Alice", "alice@example.com", "a").unwrap();
        let err = ring
            .seal_outgoing(
                "a",
                &["stranger@example.net".into()],
                PLAIN,
                SealOpts {
                    sign: false,
                    encrypt: true,
                },
            )
            .unwrap_err();
        assert!(err.contains("stranger@example.net"));
    }

    #[test]
    fn no_options_is_the_message_unchanged() {
        let (_d, ring) = keyring();
        assert_eq!(
            ring.seal_outgoing("a", &[], PLAIN, SealOpts::default())
                .unwrap(),
            PLAIN
        );
    }

    #[test]
    fn addresses_come_out_of_every_user_id_shape() {
        assert_eq!(
            address_of("Alice <A@Example.com>").as_deref(),
            Some("a@example.com")
        );
        assert_eq!(
            address_of("a@example.com").as_deref(),
            Some("a@example.com")
        );
        assert_eq!(address_of("Alice"), None);
        assert_eq!(
            address_of("Alice (work) <a@b.example>").as_deref(),
            Some("a@b.example")
        );
    }

    // ── Re-import with other user ids (gap 76) and revocation / expiry (gap 88) ─

    use pgp::packet::{PacketTrait as _, Signature, SignatureConfig, SignatureType, Subpacket, SubpacketData};
    use pgp::types::{Duration as PgpDuration, Password as Pin, Timestamp};

    const DAY: u32 = 86_400;

    fn secs_ago(days: u32) -> Timestamp {
        Timestamp::from_secs(now_secs() - days * DAY)
    }

    /// `config` with its creation time replaced and a key expiry added (or
    /// dropped with `None`); the fields every self-signature of ours carries
    /// stay as they were.
    fn config_with(
        old: &Signature,
        created: u32,
        key_expiry_days: Option<u32>,
    ) -> SignatureConfig {
        let mut config = old.config().unwrap().clone();
        config.hashed_subpackets.retain(|p| {
            !matches!(
                p.data,
                SubpacketData::KeyExpirationTime(_) | SubpacketData::SignatureCreationTime(_)
            )
        });
        config.hashed_subpackets.push(
            Subpacket::regular(SubpacketData::SignatureCreationTime(Timestamp::from_secs(created)))
                .unwrap(),
        );
        if let Some(days) = key_expiry_days {
            config.hashed_subpackets.push(
                Subpacket::regular(SubpacketData::KeyExpirationTime(PgpDuration::from_secs(
                    days * DAY,
                )))
                .unwrap(),
            );
        }
        config
    }

    /// The primary key's certification of every user id re-issued so the key
    /// expires `days` after it was created.
    fn expiring_after(mut key: SignedSecretKey, days: u32) -> SignedSecretKey {
        let public = key.primary_key.public_key().clone();
        let created = key.primary_key.created_at().as_secs();
        for user in key.details.users.iter_mut() {
            let config = config_with(&user.signatures[0], created, Some(days));
            let sig = config
                .sign_certification(&key.primary_key, &public, &Pin::empty(), user.id.tag(), &user.id)
                .unwrap();
            user.signatures = vec![sig];
        }
        key
    }

    /// A user id added to `key` and certified by it: the same fingerprint, a new
    /// claim (gap 76's "updated key").
    fn with_extra_user(mut key: SignedSecretKey, uid: &str) -> SignedSecretKey {
        let public = key.primary_key.public_key().clone();
        let id = pgp::packet::UserId::from_str(Default::default(), uid).unwrap();
        let config = config_with(&key.details.users[0].signatures[0], now_secs(), None);
        let sig = config
            .sign_certification(&key.primary_key, &public, &Pin::empty(), id.tag(), &id)
            .unwrap();
        key.details.users.push(id.into_signed(sig));
        key
    }

    fn revoke_key(mut key: SignedSecretKey) -> SignedSecretKey {
        let public = key.primary_key.public_key().clone();
        let mut config = SignatureConfig::from_key(
            rand::rngs::OsRng,
            &key.primary_key,
            SignatureType::KeyRevocation,
        )
        .unwrap();
        config.hashed_subpackets = vec![
            Subpacket::regular(SubpacketData::SignatureCreationTime(Timestamp::now())).unwrap(),
            Subpacket::regular(SubpacketData::IssuerFingerprint(key.primary_key.fingerprint()))
                .unwrap(),
        ];
        let sig = config
            .sign_key(&key.primary_key, &Pin::empty(), &public)
            .unwrap();
        key.details.revocation_signatures.push(sig);
        key
    }

    /// Subkey `index` (0: signing, 1: encryption) re-bound so it expires `days`
    /// after its creation, or revoked (`revoke`).
    fn rebind_subkey(
        mut key: SignedSecretKey,
        index: usize,
        expires_days: Option<u32>,
        revoke: bool,
    ) -> SignedSecretKey {
        let public = key.primary_key.public_key().clone();
        let sub = &mut key.secret_subkeys[index];
        let created = sub.key.created_at().as_secs();
        let binding = sub.signatures[0].clone();
        let mut config = config_with(&binding, created, expires_days);
        if revoke {
            config.typ = SignatureType::SubkeyRevocation;
        }
        let sig = config
            .sign_subkey_binding(
                &key.primary_key,
                &public,
                &Pin::empty(),
                sub.key.public_key(),
            )
            .unwrap();
        // A revocation comes in addition to the binding; a re-expiry replaces it.
        if revoke {
            sub.signatures.push(sig);
        } else {
            sub.signatures = vec![sig];
        }
        // The public copy the key carries beside the secret one is the secret
        // subkey's own record, so nothing else to update.
        key
    }

    /// A detached text signature over `data` by `key`'s signing subkey that says
    /// it was made at `when` (seconds since the epoch).
    fn signature_at(key: &SignedSecretKey, data: &[u8], when: u32) -> String {
        use pgp::composed::DetachedSignature;
        let signer = key
            .secret_subkeys
            .iter()
            .find(|s| s.algorithm().can_sign())
            .unwrap();
        let mut config = SignatureConfig::from_key(rand::rngs::OsRng, &signer.key, SignatureType::Text)
            .unwrap();
        config.hashed_subpackets = vec![
            Subpacket::regular(SubpacketData::SignatureCreationTime(Timestamp::from_secs(when)))
                .unwrap(),
            Subpacket::regular(SubpacketData::IssuerFingerprint(signer.key.fingerprint())).unwrap(),
        ];
        let sig = config
            .sign(&signer.key, &Pin::empty(), data)
            .unwrap();
        DetachedSignature::new(sig)
            .to_armored_string(Default::default())
            .unwrap()
    }

    fn import_secret(ring: &PgpKeyring, key: &SignedSecretKey) -> PgpKeyInfo {
        ring.import(&key.to_bytes().unwrap()).unwrap().remove(0)
    }

    fn import_public(ring: &PgpKeyring, key: &SignedSecretKey) -> PgpKeyInfo {
        let public = SignedPublicKey::from(key.clone());
        ring.import(&public.to_bytes().unwrap()).unwrap().remove(0)
    }

    // 76

    /// The fingerprint does not cover the user ids: a correspondent the user
    /// verified can send "my updated key" with someone else's address on it. The
    /// copy must not keep the tick.
    #[test]
    fn a_re_import_with_other_user_ids_drops_verified_and_says_why() {
        let key = generate_curve25519("Friend <friend@corp.example>").unwrap();
        let updated = with_extra_user(key.clone(), "Boss <boss@corp.example>");
        let (_d, mine) = keyring();
        let first = import_public(&mine, &key);
        mine.set_verified(&first.fingerprint, true).unwrap();

        let again = import_public(&mine, &updated);
        assert_eq!(again.fingerprint, first.fingerprint, "the same key");
        assert!(again.addresses.contains(&"boss@corp.example".to_string()));
        assert!(!again.verified, "a new claim is not the one the user compared");
        assert_eq!(again.notes, vec!["identities-changed-unverified"]);
        assert!(!mine.get(&first.fingerprint).unwrap().unwrap().verified, "and it is stored so");
        assert_eq!(mine.get(&first.fingerprint).unwrap().unwrap().notes.len(), 0);
    }

    #[test]
    fn a_re_import_with_the_same_user_ids_keeps_verified_in_any_order() {
        let key = with_extra_user(
            generate_curve25519("Friend <friend@corp.example>").unwrap(),
            "Other <other@corp.example>",
        );
        let mut reordered = key.clone();
        reordered.details.users.reverse();
        let (_d, mine) = keyring();
        let first = import_public(&mine, &key);
        mine.set_verified(&first.fingerprint, true).unwrap();

        let again = import_public(&mine, &reordered);
        assert!(again.verified);
        assert!(again.notes.is_empty());
    }

    /// For a private key the account bindings go too: the bind checked the ids
    /// only when it was made.
    #[test]
    fn a_secret_re_import_with_other_user_ids_unbinds_and_unverifies() {
        let key = generate_curve25519("Me <me@example.com>").unwrap();
        let (_d, mine) = keyring();
        let info = import_secret(&mine, &key);
        let own = vec!["me@example.com".to_string()];
        mine.bind_account(&info.fingerprint, "acct-1", true, "me@example.com", &own, true)
            .unwrap();
        mine.set_verified(&info.fingerprint, true).unwrap();
        assert_eq!(mine.get(&info.fingerprint).unwrap().unwrap().accounts, vec!["acct-1"]);

        let swapped = with_extra_user(key, "Boss <boss@corp.example>");
        let again = import_secret(&mine, &swapped);
        assert!(!again.verified);
        assert!(again.accounts.is_empty(), "the binding is gone");
        assert_eq!(
            again.notes,
            vec!["identities-changed-unverified", "identities-changed-unbound"]
        );
        assert!(mine.secret_for_account("acct-1").unwrap().is_none());
    }

    // 88

    #[test]
    fn an_expired_key_is_listed_as_expired_and_is_never_a_candidate_or_a_recipient() {
        let made = build_curve25519("Old <old@example.org>", Some(secs_ago(100))).unwrap();
        let key = expiring_after(made, 30);
        let (_d, mine) = keyring();
        let info = import_public(&mine, &key);
        mine.set_verified(&info.fingerprint, true).unwrap();

        let listed = mine.get(&info.fingerprint).unwrap().unwrap();
        assert!(listed.expired && !listed.revoked);
        assert!(mine.candidates_for(std::slice::from_ref(&info.fingerprint)).unwrap().is_empty());
        assert!(mine.public_for_address("old@example.org").unwrap().is_none());
        let err = mine
            .encrypt_to("none", &["old@example.org".to_string()], b"hi")
            .unwrap_err();
        assert!(err.contains("old@example.org"), "{err}");

    }

    /// The user's decision on gap 88: an expired key keeps its old signatures.
    /// The key lived from 100 to 70 days ago.
    #[test]
    fn an_old_signature_of_an_expired_key_still_verifies() {
        let made = build_curve25519("Old <old@example.org>", Some(secs_ago(100))).unwrap();
        let key = expiring_after(made, 30);
        let (_d, mine) = keyring();
        let info = import_public(&mine, &key);
        mine.set_verified(&info.fingerprint, true).unwrap();
        assert!(mine.get(&info.fingerprint).unwrap().unwrap().expired);

        let sig = signature_at(&key, b"hello", now_secs() - 90 * DAY);
        assert!(
            matches!(
                mine.verify_detached(b"hello", sig.as_bytes()),
                VerifyOutcome::Good { trust: SignerTrust::Verified, .. }
            ),
            "{:?}",
            mine.verify_detached(b"hello", sig.as_bytes())
        );
    }

    #[test]
    fn a_new_signature_of_an_expired_key_is_bad() {
        let made = build_curve25519("Old <old@example.org>", Some(secs_ago(100))).unwrap();
        let key = expiring_after(made, 30);
        let (_d, mine) = keyring();
        let info = import_public(&mine, &key);
        mine.set_verified(&info.fingerprint, true).unwrap();

        let sig = signature_at(&key, b"hello", now_secs() - 10 * DAY);
        assert_eq!(mine.verify_detached(b"hello", sig.as_bytes()), VerifyOutcome::Bad);
        let sig = signature_at(&key, b"hello", now_secs());
        assert_eq!(mine.verify_detached(b"hello", sig.as_bytes()), VerifyOutcome::Bad);
    }

    /// A thief of a key can date a signature however they like, so a revoked
    /// key's signature is Unusable even when it claims a date before the
    /// revocation.
    #[test]
    fn an_old_signature_of_a_revoked_key_is_unusable() {
        let made = build_curve25519("Leaked <leaked@example.org>", Some(secs_ago(100))).unwrap();
        let sig = signature_at(&made, b"x", now_secs() - 50 * DAY);
        let revoked = revoke_key(made);
        let (_d, mine) = keyring();
        let info = import_public(&mine, &revoked);
        mine.set_verified(&info.fingerprint, true).unwrap();
        assert_eq!(
            mine.verify_detached(b"x", sig.as_bytes()),
            VerifyOutcome::Unusable("signer-key-revoked".into())
        );
    }

    #[test]
    fn a_key_whose_every_user_id_is_revoked_is_unusable() {
        let key = generate_curve25519("Me <me@example.com>").unwrap();
        let sig = signature_at(&key, b"x", now_secs() - DAY);
        let mut revoked = key.clone();
        let public = revoked.primary_key.public_key().clone();
        let user = &mut revoked.details.users[0];
        let mut config = config_with(&user.signatures[0], now_secs(), None);
        config.typ = SignatureType::CertRevocation;
        let rev = config
            .sign_certification(&key.primary_key, &public, &Pin::empty(), user.id.tag(), &user.id)
            .unwrap();
        user.signatures.push(rev);
        let (_d, mine) = keyring();
        let info = import_public(&mine, &revoked);
        assert!(mine.get(&info.fingerprint).unwrap().unwrap().revoked);
        assert_eq!(
            mine.verify_detached(b"x", sig.as_bytes()),
            VerifyOutcome::Unusable("signer-key-revoked".into())
        );
    }

    #[test]
    fn a_key_with_expiry_in_the_future_is_still_good() {
        let made = build_curve25519("New <new@example.org>", Some(secs_ago(10))).unwrap();
        let key = expiring_after(made, 365);
        let (_d, mine) = keyring();
        let info = import_public(&mine, &key);
        assert!(!mine.get(&info.fingerprint).unwrap().unwrap().expired);
        let sig = signature_at(&key, b"x", now_secs());
        assert!(matches!(
            mine.verify_detached(b"x", sig.as_bytes()),
            VerifyOutcome::Good { .. }
        ));
        assert!(mine.public_for_address("new@example.org").unwrap().is_some());
    }

    #[test]
    fn a_signature_made_before_the_key_existed_or_after_its_expiry_is_bad() {
        let made = build_curve25519("Live <live@example.org>", Some(secs_ago(10))).unwrap();
        let key = expiring_after(made, 20);
        let created = key.primary_key.created_at().as_secs();
        let (_d, mine) = keyring();
        import_public(&mine, &key);

        let good = signature_at(&key, b"x", now_secs());
        assert!(matches!(mine.verify_detached(b"x", good.as_bytes()), VerifyOutcome::Good { .. }));
        let before = signature_at(&key, b"x", created - DAY);
        assert_eq!(mine.verify_detached(b"x", before.as_bytes()), VerifyOutcome::Bad);
        let after = signature_at(&key, b"x", created + 25 * DAY);
        assert_eq!(mine.verify_detached(b"x", after.as_bytes()), VerifyOutcome::Bad);
    }

    #[test]
    fn a_revoked_key_is_listed_as_revoked_and_no_signature_of_it_is_trusted() {
        let key = generate_curve25519("Leaked <leaked@example.org>").unwrap();
        let sig = signature_at(&key, b"x", now_secs());
        let revoked = revoke_key(key.clone());
        let (_d, mine) = keyring();
        let info = import_public(&mine, &revoked);
        mine.set_verified(&info.fingerprint, true).unwrap();

        let listed = mine.get(&info.fingerprint).unwrap().unwrap();
        assert!(listed.revoked, "shown as revoked");
        assert!(listed.verified, "the tick is the user's; the revocation outranks it");
        assert!(mine.candidates_for(&[]).unwrap().is_empty());
        assert!(mine.public_for_address("leaked@example.org").unwrap().is_none());
        assert_eq!(
            mine.verify_detached(b"x", sig.as_bytes()),
            VerifyOutcome::Unusable("signer-key-revoked".into())
        );
    }

    /// With the genuine key only Known and a leaked copy of the same address
    /// Verified-then-revoked, encryption goes to the genuine one.
    #[test]
    fn a_revoked_verified_key_does_not_win_the_address() {
        let leaked = revoke_key(generate_curve25519("Friend <friend@corp.example>").unwrap());
        let genuine = generate_curve25519("Friend <friend@corp.example>").unwrap();
        let (_d, mine) = keyring();
        let l = import_public(&mine, &leaked);
        mine.set_verified(&l.fingerprint, true).unwrap();
        let g = import_public(&mine, &genuine);
        let (_k, info) = mine.public_for_address("friend@corp.example").unwrap().unwrap();
        assert_eq!(info.fingerprint, g.fingerprint);
    }

    #[test]
    fn a_subkey_outside_its_life_cannot_vouch_for_a_signature() {
        // The signing subkey was created 10 days ago and expires after one.
        let made = build_curve25519("Sub <sub@example.org>", Some(secs_ago(10))).unwrap();
        let key = rebind_subkey(made, 0, Some(1), false);
        let created = key.secret_subkeys[0].key.created_at().as_secs();
        let (_d, mine) = keyring();
        import_public(&mine, &key);

        let inside = signature_at(&key, b"x", created + DAY / 2);
        assert!(matches!(mine.verify_detached(b"x", inside.as_bytes()), VerifyOutcome::Good { .. }));
        let outside = signature_at(&key, b"x", now_secs());
        assert_eq!(mine.verify_detached(b"x", outside.as_bytes()), VerifyOutcome::Bad);
    }

    #[test]
    fn a_revoked_subkey_cannot_vouch_and_is_not_signed_or_encrypted_with() {
        let key = rebind_subkey(
            rebind_subkey(generate_curve25519("Rev <rev@example.org>").unwrap(), 0, None, true),
            1,
            None,
            true,
        );
        let (_d, mine) = keyring();
        let info = import_secret(&mine, &key);
        let own = vec!["rev@example.org".to_string()];
        mine.bind_account(&info.fingerprint, "acct-1", true, "rev@example.org", &own, true)
            .unwrap();

        let sig = signature_at(&key, b"x", now_secs());
        assert_eq!(mine.verify_detached(b"x", sig.as_bytes()), VerifyOutcome::Unusable("signer-key-revoked".into()));
        assert!(mine.sign_detached("acct-1", b"x").is_err(), "no signing with a revoked subkey");
        let err = mine
            .encrypt_to("acct-1", &["rev@example.org".to_string()], b"x")
            .unwrap_err();
        assert!(err.contains("encryption subkey"), "{err}");
    }

    #[test]
    fn an_expired_encryption_subkey_is_passed_over_for_encryption() {
        let made = build_curve25519("Enc <enc@example.org>", Some(secs_ago(10))).unwrap();
        let key = rebind_subkey(made, 1, Some(1), false);
        let (_d, mine) = keyring();
        import_public(&mine, &key);
        let (_d2, me) = keyring();
        me.generate("Me", "me@example.com", "acct-1").unwrap();
        // Hand `mine`'s view of the recipient to a ring that can sign.
        let recipient = SignedPublicKey::from(key.clone());
        me.import(&recipient.to_bytes().unwrap()).unwrap();
        let err = me
            .encrypt_to("acct-1", &["enc@example.org".to_string()], b"x")
            .unwrap_err();
        assert!(err.contains("encryption subkey"), "{err}");
    }

    #[test]
    fn a_revoked_user_id_is_not_one_of_the_keys_identities() {
        let key = with_extra_user(
            generate_curve25519("Me <me@example.com>").unwrap(),
            "Old <old@example.com>",
        );
        // The owner revokes the second id.
        let mut revoked = key.clone();
        let public = revoked.primary_key.public_key().clone();
        let user = &mut revoked.details.users[1];
        let mut config = config_with(&user.signatures[0], now_secs(), None);
        config.typ = SignatureType::CertRevocation;
        let sig = config
            .sign_certification(&key.primary_key, &public, &Pin::empty(), user.id.tag(), &user.id)
            .unwrap();
        user.signatures.push(sig);

        let (_d, mine) = keyring();
        let info = import_public(&mine, &revoked);
        assert_eq!(info.addresses, vec!["me@example.com"]);
        assert!(mine.public_for_address("old@example.com").unwrap().is_none());
    }

    #[test]
    fn a_key_info_from_an_older_file_reads_without_the_new_fields() {
        let info: PgpKeyInfo = serde_json::from_str(
            r#"{"fingerprint":"AB","identities":[],"addresses":[],"secret":true,"verified":false,"accounts":[],"algorithm":"Curve25519"}"#,
        )
        .unwrap();
        assert!(!info.revoked && !info.expired && info.notes.is_empty());
        assert_eq!(info.origin, KeyOrigin::Imported);
    }

    // ── Review probes (I2 review) ────────────────────────────────────────────

    /// A mailing-list footer after the closing boundary and a preamble before
    /// the first one are outside the multipart; a genuine signed mail with them
    /// must still read Verified, and show only the signed part.
    #[test]
    fn a_preamble_and_an_epilogue_outside_the_multipart_do_not_spoil_a_genuine_signature() {
        use crate::schema::mail::MailCryptoState;
        let (_d, ring) = verified_alice();
        let raw = signed_mail_with(&ring, "");
        let raw = raw.replacen("\r\n\r\n--", "\r\n\r\nThis is a multi-part message.\r\n\r\n--", 1)
            + "\r\n-- \r\nlist footer: UNSUBSCRIBE\r\n";
        let (shown, info) = check(&ring, &raw, "alice@example.com");
        assert_eq!(info.state, MailCryptoState::Verified, "{info:?}");
        let shown = String::from_utf8(shown.unwrap()).unwrap();
        assert!(!shown.contains("UNSUBSCRIBE") && !shown.contains("multi-part message"), "{shown}");
    }

    /// A revocation is permanent: re-importing an older copy of the same key
    /// (one made before the owner revoked it) must not bring it back.
    #[test]
    fn re_importing_an_older_copy_does_not_undo_a_revocation() {
        let key = generate_curve25519("Alice <alice@example.org>").unwrap();
        let revoked = revoke_key(key.clone());
        let (_d, mine) = keyring();
        let first = import_public(&mine, &revoked);
        mine.set_verified(&first.fingerprint, true).unwrap();
        assert!(mine.get(&first.fingerprint).unwrap().unwrap().revoked);

        // The same fingerprint and user ids, without the revocation.
        let again = import_public(&mine, &key);
        assert_eq!(again.fingerprint, first.fingerprint);
        let now = mine.get(&first.fingerprint).unwrap().unwrap();
        assert!(now.revoked, "the older copy brought a revoked key back");
        assert!(mine.public_for_address("alice@example.org").unwrap().is_none());
    }

    /// The same for a secret copy, and for a revoked subkey.
    #[test]
    fn an_older_secret_or_subkey_copy_does_not_undo_a_revocation_either() {
        let key = generate_curve25519("Alice <alice@example.org>").unwrap();
        let (_d, mine) = keyring();
        import_secret(&mine, &revoke_key(key.clone()));
        let fp = import_secret(&mine, &key).fingerprint;
        assert!(mine.get(&fp).unwrap().unwrap().revoked, "secret re-import");

        let key = generate_curve25519("Bob <bob@example.org>").unwrap();
        let sub_revoked = rebind_subkey(key.clone(), 1, None, true);
        let (_d2, mine) = keyring();
        import_public(&mine, &sub_revoked);
        import_public(&mine, &key);
        let held = mine.read().unwrap().entries.remove(0);
        let stored = parse_public(&held).unwrap();
        assert!(
            stored.public_subkeys[1]
                .signatures
                .iter()
                .any(|s| s.typ() == Some(SignatureType::SubkeyRevocation)),
            "the subkey revocation survived the older copy"
        );
    }
}

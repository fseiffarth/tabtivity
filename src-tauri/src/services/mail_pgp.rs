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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredKey {
    fingerprint: String,
    #[serde(default)]
    identities: Vec<String>,
    /// Whether `material` is a transferable *secret* key.
    secret: bool,
    /// `true` once the user has confirmed the fingerprint out of band.
    #[serde(default)]
    verified: bool,
    /// Mail account ids this key is the identity for. Only meaningful for a
    /// secret key.
    #[serde(default)]
    accounts: Vec<String>,
    #[serde(default)]
    algorithm: String,
    /// Base64 of the binary OpenPGP key packet stream.
    material: String,
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
    /// The user has compared this fingerprint out of band.
    pub verified: bool,
    pub accounts: Vec<String>,
    pub algorithm: String,
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
        Ok(raw) => mail_crypt::open(&keys.wrap, KEYRING_AAD, &raw)
            .map(|plain| Some(Zeroizing::new(plain.to_vec())))
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

impl PgpKeyring {
    /// Open (or create) the keyring in `dir`, sealed under the store's `k_wrap`.
    pub fn open(dir: &Path, keys: &MailKeys) -> Result<Self, String> {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        Ok(PgpKeyring {
            path: dir.join(KEYRING_FILE),
            wrap: keys.wrap.clone(),
        })
    }

    fn read(&self) -> Result<KeyringFile, String> {
        match std::fs::read(&self.path) {
            Ok(raw) => {
                let plain = mail_crypt::open(&self.wrap, KEYRING_AAD, &raw)
                    .map_err(|e| format!("the keyring could not be decrypted: {e}"))?;
                let file: KeyringFile = serde_json::from_slice(&plain)
                    .map_err(|e| format!("the keyring is corrupt: {e}"))?;
                if file.version != KEYRING_VERSION {
                    return Err(format!(
                        concat!("this keyring was written by a newer version of ", crate::app_name!(), " (v{})"),
                        file.version
                    ));
                }
                Ok(file)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(KeyringFile {
                version: KEYRING_VERSION,
                entries: Vec::new(),
            }),
            Err(e) => Err(e.to_string()),
        }
    }

    fn write(&self, file: &KeyringFile) -> Result<(), String> {
        let json = Zeroizing::new(serde_json::to_vec(file).map_err(|e| e.to_string())?);
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
            // watched it being made. This is the one place `verified` is set
            // without a fingerprint comparison, and it is not a shortcut.
            verified: true,
            accounts: vec![account_id.to_string()],
            algorithm: "Curve25519".into(),
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
    /// An imported public key is `Known`, never `Verified` — importing is not
    /// checking. Only [`PgpKeyring::set_verified`] promotes it, and only from an
    /// explicit "I compared this fingerprint" click.
    pub fn import(&self, data: &[u8]) -> Result<Vec<PgpKeyInfo>, String> {
        let mut file = self.read()?;
        let mut added = Vec::new();

        // Secret first: a transferable secret key also parses as a public one in
        // some readers, and the secret half is the more useful reading.
        let secrets = SignedSecretKey::from_reader_many(data)
            .ok()
            .map(|(iter, _)| iter.flatten().collect::<Vec<_>>())
            .unwrap_or_default();
        for key in secrets {
            key.verify_bindings()
                .map_err(|e| format!("this key's own self-signatures do not check out: {e}"))?;
            let fingerprint = fingerprint_hex(&key.fingerprint());
            let material = key.to_bytes().map_err(|e| e.to_string())?;
            let entry = StoredKey {
                fingerprint: fingerprint.clone(),
                identities: user_ids_of_details(&key.details),
                secret: true,
                // Importing a *private* key is possession, not a claim about
                // someone else, so it needs no out-of-band check either.
                verified: true,
                accounts: carry_accounts(&file, &fingerprint),
                algorithm: algorithm_label(key.algorithm()),
                material: B64.encode(&material),
            };
            file.entries.retain(|e| e.fingerprint != fingerprint);
            file.entries.push(entry.clone());
            added.push(info_of(&entry));
        }

        if added.is_empty() {
            let (publics, _) = SignedPublicKey::from_reader_many(data)
                .map_err(|_| "this does not look like an OpenPGP key".to_string())?;
            for key in publics.flatten() {
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
                let material = key.to_bytes().map_err(|e| e.to_string())?;
                let entry = StoredKey {
                    fingerprint: fingerprint.clone(),
                    identities: user_ids_of_details(&key.details),
                    secret: false,
                    verified: was_verified(&file, &fingerprint),
                    accounts: Vec::new(),
                    algorithm: algorithm_label(key.algorithm()),
                    material: B64.encode(&material),
                };
                file.entries.retain(|e| e.fingerprint != fingerprint);
                file.entries.push(entry.clone());
                added.push(info_of(&entry));
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
    /// The only way a key becomes `Verified`, and therefore the only way any
    /// message ever earns positive chrome. It is a deliberate, per-key,
    /// user-initiated act — there is no heuristic that can stand in for it,
    /// because there is no authority to ask.
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

    /// Bind (or with `None`, unbind) one of our own keys to a mail account.
    pub fn bind_account(
        &self,
        fingerprint: &str,
        account_id: &str,
        bind: bool,
    ) -> Result<(), String> {
        let fp = normalize_fingerprint(fingerprint);
        let mut file = self.read()?;
        // One key per account: a second binding would make "which key signs this
        // message" a question with two answers.
        if bind {
            for e in file.entries.iter_mut() {
                e.accounts.retain(|a| a != account_id);
            }
        }
        let entry = file
            .entries
            .iter_mut()
            .find(|e| e.fingerprint == fp)
            .ok_or("no such key")?;
        if !entry.secret && bind {
            return Err(
                "only a key you hold the private half of can be an account's identity".into(),
            );
        }
        entry.accounts.retain(|a| a != account_id);
        if bind {
            entry.accounts.push(account_id.to_string());
        }
        self.write(&file)
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
    pub fn candidates_for(
        &self,
        key_ids: &[String],
    ) -> Result<Vec<(SignedPublicKey, PgpKeyInfo)>, String> {
        let file = self.read()?;
        let wanted: Vec<String> = key_ids
            .iter()
            .map(|k| normalize_fingerprint(k))
            .filter(|k| !k.is_empty())
            .collect();
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
                out.push((key, info_of(entry)));
            }
        }
        Ok(out)
    }

    /// The public key to encrypt to for `address`, if we hold one.
    pub fn public_for_address(
        &self,
        address: &str,
    ) -> Result<Option<(SignedPublicKey, PgpKeyInfo)>, String> {
        let wanted = address.trim().to_ascii_lowercase();
        let file = self.read()?;
        // Prefer a verified key over a merely known one with the same address:
        // if the user has checked one of them, that is the one they meant.
        let mut best: Option<&StoredKey> = None;
        for entry in &file.entries {
            if !info_of(entry).addresses.contains(&wanted) {
                continue;
            }
            if best.is_none_or(|b| !b.verified && entry.verified) {
                best = Some(entry);
            }
        }
        match best {
            Some(entry) => Ok(Some((parse_public(entry)?, info_of(entry)))),
            None => Ok(None),
        }
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

        let candidates = match self.candidates_for(&issuers) {
            Ok(c) => c,
            Err(e) => return VerifyOutcome::Unusable(format!("keyring-unreadable:{e}")),
        };
        if candidates.is_empty() {
            return VerifyOutcome::NoKey {
                key_id: issuers.into_iter().next(),
            };
        }

        for (key, info) in &candidates {
            // The primary key and every subkey: signing is normally done by a
            // *subkey*, so checking only the primary would fail every ordinary
            // modern key and report it as forged.
            if sig.verify(key, signed).is_ok() || sig.verify(&key.primary_key, signed).is_ok() {
                return good_outcome(info);
            }
            for sub in &key.public_subkeys {
                if sig.verify(sub, signed).is_ok() {
                    return good_outcome(info);
                }
            }
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
        let signer = key
            .secret_subkeys
            .iter()
            .find(|s| s.algorithm().can_sign())
            .ok_or("this key has no signing subkey")?;

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
        for key in &keys {
            // The **encryption subkey**. Encrypting to a certify-only primary
            // produces a message the recipient's own client cannot open.
            let subkey = key
                .public_subkeys
                .iter()
                .find(|s| s.algorithm().can_encrypt())
                .ok_or("a recipient's key has no encryption subkey")?;
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
    use mail_parser::{MimeHeaders, PartType};

    // The `multipart/signed` node, and its two children in order. The **root**
    // only, matching `mail_crypto::detect`: a signed node nested beside other
    // content covers none of that content, and a signature checked there would
    // lend its verdict to parts the sender never saw.
    let root = msg.root_part();
    let children = {
        let ctype = root.content_type()?;
        let signed = ctype.ctype().eq_ignore_ascii_case("multipart")
            && ctype
                .subtype()
                .is_some_and(|s| s.eq_ignore_ascii_case("signed"));
        match (&root.body, signed) {
            (PartType::Multipart(ids), true) if ids.len() >= 2 => ids.clone(),
            _ => return None,
        }
    };

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

/// The ciphertext part of an RFC 3156 `multipart/encrypted` message.
pub fn encrypted_part_bytes(raw: &[u8], msg: &mail_parser::Message<'_>) -> Option<Vec<u8>> {
    use mail_parser::{MimeHeaders, PartType};
    // The root only, for the reason `signed_part_bytes` gives: a ciphertext
    // nested in someone else's message must not be decrypted into it.
    let root = msg.root_part();
    let children = {
        let ctype = root.content_type()?;
        let enc = ctype.ctype().eq_ignore_ascii_case("multipart")
            && ctype
                .subtype()
                .is_some_and(|s| s.eq_ignore_ascii_case("encrypted"));
        match (&root.body, enc) {
            (PartType::Multipart(ids), true) if ids.len() >= 2 => ids.clone(),
            _ => return None,
        }
    };
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

fn carry_accounts(file: &KeyringFile, fingerprint: &str) -> Vec<String> {
    file.entries
        .iter()
        .find(|e| e.fingerprint == fingerprint)
        .map(|e| e.accounts.clone())
        .unwrap_or_default()
}

fn was_verified(file: &KeyringFile, fingerprint: &str) -> bool {
    file.entries
        .iter()
        .find(|e| e.fingerprint == fingerprint)
        .map(|e| e.verified)
        .unwrap_or(false)
}

fn info_of(entry: &StoredKey) -> PgpKeyInfo {
    PgpKeyInfo {
        fingerprint: entry.fingerprint.clone(),
        addresses: entry
            .identities
            .iter()
            .filter_map(|u| address_of(u))
            .collect(),
        identities: entry.identities.clone(),
        secret: entry.secret,
        verified: entry.verified,
        accounts: entry.accounts.clone(),
        algorithm: entry.algorithm.clone(),
    }
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

fn user_ids_of_details(details: &pgp::composed::SignedKeyDetails) -> Vec<String> {
    details
        .users
        .iter()
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
        let ring = PgpKeyring::open(dir.path(), &keys).unwrap();
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
            PgpKeyring::open(dir.path(), &MailKeys::derive(Key::from_bytes([11u8; 32]))).unwrap();
        ring.generate("Alice", "alice@example.com", "a").unwrap();

        let wrong =
            PgpKeyring::open(dir.path(), &MailKeys::derive(Key::from_bytes([12u8; 32]))).unwrap();
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
        assert!(mine.bind_account(&fp, "acct-1", true).is_err());
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
}

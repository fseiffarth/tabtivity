//! The device-released secrets key, wired (hosted plan §6.8, TODO #2350).
//! [`super::secrets`] holds the cryptography; this is who holds K, when, and
//! what it opens.
//!
//! * **One vault per daemon**, installed by `serverd` at start ([`install`]).
//!   The desktop never installs one, so [`vault`] is `None` there and every
//!   caller (`mail_crypt`, `remote_credentials`, the phone routes) keeps its
//!   desktop behaviour unchanged.
//! * **K is held by a [`KeyHold`]**: the kernel's per-user persistent keyring
//!   on a server ([`KernelKeyring`]), a [`MemoryHold`] in tests. It is read
//!   from the hold on every use, never cached in the vault, so a keyring
//!   flush locks at once and a daemon restart finds K again.
//! * **Set-up** mints K, wraps it for every device that has enrolled an ECDH
//!   key and once under a recovery code, which is returned once and never
//!   stored.
//! * **Enrolment**: a signed-in device registers its ECDH public key with a
//!   signature of its pairing key (the session cookie alone cannot), and
//!   pins this daemon's identity key ([`Vault::identity_public`]).
//! * **The unlock exchange**: [`Vault::start_unlock`] hands the device X's
//!   public key (from its wrap) and a fresh transport key E, both signed by
//!   the identity key; the device returns `ECDH(device, X)` sealed to
//!   `ECDH(T, E)` (HKDF-SHA256 → AES-256-GCM), so the TLS-terminating gateway
//!   sees only ciphertext; [`Vault::finish_unlock`] opens it and the wrap.
//! * **What K opens**: `mail_crypt`'s device mode (its KEK is
//!   [`Vault::subkey`]`(K, "mail-kek")`), and the sealed credential store
//!   (`<state>/secrets/credentials.json`, the opt-in IMAP/SMTP/CalDAV/SSH
//!   passwords, under `subkey(K, "credentials")`) that stands in for the OS
//!   keychain on a server.
//!
//! A home directory (or a backup of it) therefore holds the wraps, the
//! identity key and sealed files — nothing that opens without a paired
//! device or the recovery code.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64ct::{Base64UrlUnpadded, Encoding};
use hkdf::Hkdf;
use p256::ecdh::EphemeralSecret;
use p256::ecdsa::signature::{Signer, Verifier};
use p256::ecdsa::{Signature, SigningKey, VerifyingKey};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::pkcs8::{DecodePublicKey, EncodePublicKey};
use p256::PublicKey;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::Zeroizing;

use super::secrets::{self, MasterKey, WrapFile};

/// How long an unlock exchange may take between its two halves.
const EXCHANGE_TTL: u64 = 60;
/// Exchanges pending at once (one per device per minute is the normal case).
const MAX_EXCHANGES: usize = 32;
/// The largest ECDH public key a device may enrol (SEC1 uncompressed is 65).
const MAX_ECDH_KEY: usize = 133;

/// Where K lives while unlocked.
pub trait KeyHold: Send + Sync {
    fn put(&self, key: &MasterKey) -> Result<(), String>;
    fn get(&self) -> Result<Option<MasterKey>, String>;
    fn clear(&self) -> Result<(), String>;
}

/// The kernel's per-user persistent keyring (`KEYCTL_GET_PERSISTENT`): it
/// outlives the daemon, not a reboot; the fence's seccomp filter keeps every
/// agent out of it.
#[cfg(target_os = "linux")]
pub struct KernelKeyring;

#[cfg(target_os = "linux")]
impl KeyHold for KernelKeyring {
    fn put(&self, key: &MasterKey) -> Result<(), String> {
        secrets::keyring::store(key)
    }
    fn get(&self) -> Result<Option<MasterKey>, String> {
        secrets::keyring::load()
    }
    fn clear(&self) -> Result<(), String> {
        secrets::keyring::clear()
    }
}

/// K in this process only: the tests' hold (share one `Arc` between two
/// vaults to model a daemon restart; `clear` models a reboot).
#[derive(Default)]
pub struct MemoryHold(Mutex<Option<MasterKey>>);

impl KeyHold for MemoryHold {
    fn put(&self, key: &MasterKey) -> Result<(), String> {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = Some(key.clone());
        Ok(())
    }
    fn get(&self) -> Result<Option<MasterKey>, String> {
        Ok(self.0.lock().unwrap_or_else(PoisonError::into_inner).clone())
    }
    fn clear(&self) -> Result<(), String> {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = None;
        Ok(())
    }
}

/// A paired device's enrolled ECDH public key (SEC1, base64url).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceKey {
    pub id: String,
    pub ecdh: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    /// K exists (a recovery wrap is on disk).
    pub set_up: bool,
    /// K is in the hold right now.
    pub unlocked: bool,
    /// Devices that can release K.
    pub wrapped_devices: usize,
}

/// The first half of the unlock exchange, as the device gets it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum UnlockStart {
    /// K is in the hold already.
    Unlocked,
    /// Nobody has set the key up yet.
    NotSetUp,
    /// This device holds no wrap (it enrolled while K was locked, or never).
    NoWrap,
    Locked {
        id: String,
        /// The signed text: context, origin, device id, id, X, E — one per line.
        payload: String,
        /// X's public key (the wrap's), SEC1 base64url.
        ephemeral: String,
        /// E's public key (this exchange's), SEC1 base64url.
        transport: String,
        /// ECDSA P-256 / SHA-256 over `payload` by the identity key, `r ‖ s`.
        signature: String,
    },
}

struct Exchange {
    device_id: String,
    secret: EphemeralSecret,
    transport: Vec<u8>,
    expires_at: u64,
}

#[derive(Serialize, Deserialize)]
struct SealedFile {
    nonce: String,
    sealed: String,
}

type Listener = Arc<dyn Fn() + Send + Sync>;

pub struct Vault {
    state_dir: PathBuf,
    hold: Arc<dyn KeyHold>,
    exchanges: Mutex<HashMap<String, Exchange>>,
    listeners: Mutex<Vec<(&'static str, Listener)>>,
    /// Serializes read-modify-writes of `wraps.json` and `credentials.json`.
    files: Mutex<()>,
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn b64(bytes: &[u8]) -> String {
    Base64UrlUnpadded::encode_string(bytes)
}

fn unb64(text: &str) -> Result<Vec<u8>, String> {
    Base64UrlUnpadded::decode_vec(text).map_err(|_| "not base64url".to_string())
}

fn random<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    rand::rngs::OsRng.fill_bytes(&mut out);
    out
}

/// HKDF-SHA256 to 32 bytes; what the browser's `deriveKey({name: "HKDF"})`
/// computes for an AES-256 key.
pub fn hkdf32(salt: &[u8], ikm: &[u8], info: &str) -> Zeroizing<[u8; 32]> {
    let mut out = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(Some(salt), ikm).expand(info.as_bytes(), out.as_mut()).expect("32 bytes is a valid HKDF length");
    out
}

/// The text a device signs to enrol its ECDH key.
pub fn enrol_payload(origin: &str, device_id: &str, ecdh: &str) -> String {
    format!("{}\n{origin}\n{device_id}\n{ecdh}", secrets::context("enrol"))
}

impl Vault {
    pub fn new(state_dir: PathBuf, hold: Arc<dyn KeyHold>) -> Self {
        Self { state_dir, hold, exchanges: Mutex::default(), listeners: Mutex::default(), files: Mutex::default() }
    }

    fn dir(&self) -> PathBuf {
        self.state_dir.join("secrets")
    }

    fn files(&self) -> std::sync::MutexGuard<'_, ()> {
        self.files.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// K, while unlocked.
    pub fn key(&self) -> Option<MasterKey> {
        self.hold.get().ok().flatten()
    }

    pub fn is_set_up(&self) -> bool {
        WrapFile::load(&self.state_dir).map(|f| f.recovery.is_some()).unwrap_or(false)
    }

    pub fn status(&self) -> VaultStatus {
        let file = WrapFile::load(&self.state_dir).unwrap_or_default();
        VaultStatus { set_up: file.recovery.is_some(), unlocked: self.key().is_some(), wrapped_devices: file.devices.len() }
    }

    /// A key derived from K for one purpose (`"mail-kek"`, `"credentials"`).
    pub fn subkey(key: &MasterKey, purpose: &str) -> Zeroizing<[u8; 32]> {
        hkdf32(b"", key.bytes(), &secrets::context(purpose))
    }

    /// Run `f` whenever K is released (by a device or the recovery code), and
    /// once now if it is already in the hold. One listener per `name`.
    pub fn on_unlock(&self, name: &'static str, f: impl Fn() + Send + Sync + 'static) {
        let listener: Listener = Arc::new(f);
        {
            let mut listeners = self.listeners.lock().unwrap_or_else(PoisonError::into_inner);
            listeners.retain(|(n, _)| *n != name);
            listeners.push((name, listener.clone()));
        }
        if self.key().is_some() {
            listener();
        }
    }

    fn released(&self, key: &MasterKey, devices: &[DeviceKey]) -> Result<(), String> {
        self.hold.put(key)?;
        self.wrap_missing(devices);
        let listeners: Vec<Listener> = self.listeners.lock().unwrap_or_else(PoisonError::into_inner).iter().map(|(_, l)| l.clone()).collect();
        for listener in listeners {
            listener();
        }
        Ok(())
    }

    /// Mint K: wraps for every enrolled device, one under a fresh recovery
    /// code, which is returned — once; it is stored nowhere. Refused when K
    /// exists already (that would orphan everything sealed under it).
    pub fn set_up(&self, devices: &[DeviceKey]) -> Result<Zeroizing<String>, String> {
        let guard = self.files();
        if WrapFile::load(&self.state_dir)?.recovery.is_some() {
            return Err("the secrets key is set up already".into());
        }
        let key = MasterKey::generate();
        let code = secrets::recovery_code();
        let mut file = WrapFile { devices: Vec::new(), recovery: Some(secrets::wrap_with_recovery(&key, &code)?) };
        for device in devices {
            if let Ok(public) = secrets::device_key(&device.ecdh) {
                file.put(secrets::wrap_for_device(&key, &device.id, &public));
            }
        }
        // Held before it is written down: a hold that refuses (no keyring)
        // must not leave a recovery wrap for a code nobody saw.
        self.hold.put(&key)?;
        if let Err(error) = file.save(&self.state_dir) {
            let _ = self.hold.clear();
            return Err(error);
        }
        drop(guard);
        self.released(&key, &[])?;
        Ok(code)
    }

    /// While unlocked: a fresh recovery code replaces the old one (the old
    /// wrap is gone, so a lost or leaked code stops working). Returned once.
    pub fn new_recovery_code(&self) -> Result<Zeroizing<String>, String> {
        let key = self.key().ok_or("the secrets key is locked")?;
        let _guard = self.files();
        let mut file = WrapFile::load(&self.state_dir)?;
        if file.recovery.is_none() {
            return Err("the secrets key is not set up".into());
        }
        let code = secrets::recovery_code();
        file.recovery = Some(secrets::wrap_with_recovery(&key, &code)?);
        file.save(&self.state_dir)?;
        Ok(code)
    }

    /// While unlocked: wrap K for each device that has none. The count made.
    pub fn wrap_missing(&self, devices: &[DeviceKey]) -> usize {
        let Some(key) = self.key() else { return 0 };
        let _guard = self.files();
        let Ok(mut file) = WrapFile::load(&self.state_dir) else { return 0 };
        if file.recovery.is_none() {
            return 0;
        }
        let mut made = 0;
        for device in devices {
            if file.device(&device.id).is_none() {
                if let Ok(public) = secrets::device_key(&device.ecdh) {
                    file.put(secrets::wrap_for_device(&key, &device.id, &public));
                    made += 1;
                }
            }
        }
        if made > 0 && file.save(&self.state_dir).is_err() {
            return 0;
        }
        made
    }

    /// Revoking a device deletes its wrap (§6.8).
    pub fn revoke(&self, device_id: &str) {
        let _guard = self.files();
        if let Ok(mut file) = WrapFile::load(&self.state_dir) {
            if file.revoke(device_id) {
                let _ = file.save(&self.state_dir);
            }
        }
    }

    /// Every device forgotten: every device wrap goes; the recovery wrap stays.
    pub fn forget_devices(&self) {
        let _guard = self.files();
        if let Ok(mut file) = WrapFile::load(&self.state_dir) {
            if !file.devices.is_empty() {
                file.devices.clear();
                let _ = file.save(&self.state_dir);
            }
        }
    }

    /// Lock now (K out of the hold).
    pub fn lock_now(&self) -> Result<(), String> {
        self.hold.clear()
    }

    // ── Identity ─────────────────────────────────────────────────────────────

    fn identity(&self) -> Result<SigningKey, String> {
        let path = self.dir().join("identity.key");
        match std::fs::read(&path) {
            Ok(bytes) => {
                let bytes = Zeroizing::new(bytes);
                crate::services::mobile_control::store::ensure_private_file(&path)?;
                SigningKey::from_slice(&bytes).map_err(|_| "identity.key is not a P-256 key".to_string())
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let _guard = self.files();
                let key = SigningKey::random(&mut rand::rngs::OsRng);
                crate::services::mobile_control::store::ensure_private_dir(&self.dir())?;
                crate::services::mobile_control::store::write_bytes_atomic(&path, &Zeroizing::new(key.to_bytes().to_vec()), 0o600)?;
                Ok(key)
            }
            Err(e) => Err(format!("{}: {e}", path.display())),
        }
    }

    /// The identity key's public half (SPKI DER, base64url): what a device
    /// pins at enrolment and checks every unlock exchange against.
    pub fn identity_public(&self) -> Result<String, String> {
        let der = VerifyingKey::from(&self.identity()?).to_public_key_der().map_err(|e| e.to_string())?;
        Ok(b64(der.as_bytes()))
    }

    // ── Enrolment ────────────────────────────────────────────────────────────

    /// Check a device's enrolment: `ecdh` must be a P-256 key and
    /// `signature` the device's pairing key over [`enrol_payload`].
    pub fn check_enrolment(origin: &str, device_id: &str, signing_spki: &str, ecdh: &str, signature: &str) -> Result<(), String> {
        if ecdh.len() > MAX_ECDH_KEY * 2 {
            return Err("invalid_ecdh_key".into());
        }
        secrets::device_key(ecdh).map_err(|_| "invalid_ecdh_key".to_string())?;
        let der = unb64(signing_spki).map_err(|_| "invalid_public_key".to_string())?;
        let verifying = VerifyingKey::from(PublicKey::from_public_key_der(&der).map_err(|_| "invalid_public_key".to_string())?);
        let sig = unb64(signature).map_err(|_| "invalid_signature".to_string())?;
        let sig = Signature::from_slice(&sig).map_err(|_| "invalid_signature".to_string())?;
        verifying.verify(enrol_payload(origin, device_id, ecdh).as_bytes(), &sig).map_err(|_| "invalid_signature".to_string())
    }

    // ── The unlock exchange ──────────────────────────────────────────────────

    pub fn start_unlock(&self, origin: &str, device_id: &str) -> Result<UnlockStart, String> {
        if self.key().is_some() {
            return Ok(UnlockStart::Unlocked);
        }
        let file = WrapFile::load(&self.state_dir)?;
        if file.recovery.is_none() {
            return Ok(UnlockStart::NotSetUp);
        }
        let Some(wrap) = file.device(device_id) else { return Ok(UnlockStart::NoWrap) };
        let identity = self.identity()?;
        let secret = EphemeralSecret::random(&mut rand::rngs::OsRng);
        let transport = secret.public_key().to_encoded_point(false).as_bytes().to_vec();
        let id = b64(&random::<18>());
        let payload = format!("{}\n{origin}\n{device_id}\n{id}\n{}\n{}", secrets::context("unlock"), wrap.ephemeral, b64(&transport));
        let signature: Signature = identity.sign(payload.as_bytes());
        let t = now();
        let mut exchanges = self.exchanges.lock().unwrap_or_else(PoisonError::into_inner);
        exchanges.retain(|_, e| e.expires_at >= t);
        if exchanges.len() >= MAX_EXCHANGES {
            return Err("rate_limited".into());
        }
        exchanges.insert(id.clone(), Exchange { device_id: device_id.into(), secret, transport: transport.clone(), expires_at: t + EXCHANGE_TTL });
        Ok(UnlockStart::Locked { id, payload, ephemeral: wrap.ephemeral.clone(), transport: b64(&transport), signature: b64(&signature.to_bytes()) })
    }

    /// The device's answer: `sealed` is `ECDH(device, X)` under
    /// `HKDF(salt = E ‖ T, ikm = ECDH(E, T), info = context("transport") ‖ id)`,
    /// AAD `device id ‖ "\n" ‖ id`. Single use: the exchange is spent first.
    pub fn finish_unlock(&self, device_id: &str, id: &str, device_transport: &str, nonce: &str, sealed: &str, devices: &[DeviceKey]) -> Result<(), String> {
        let exchange = self.exchanges.lock().unwrap_or_else(PoisonError::into_inner).remove(id).ok_or("invalid_exchange")?;
        if exchange.device_id != device_id || exchange.expires_at < now() {
            return Err("invalid_exchange".into());
        }
        let t_raw = unb64(device_transport).map_err(|_| "invalid_exchange".to_string())?;
        let t_public = PublicKey::from_sec1_bytes(&t_raw).map_err(|_| "invalid_exchange".to_string())?;
        let shared = exchange.secret.diffie_hellman(&t_public);
        let mut salt = exchange.transport.clone();
        salt.extend_from_slice(&t_raw);
        let key = hkdf32(&salt, shared.raw_secret_bytes(), &format!("{}{id}", secrets::context("transport")));
        let nonce = unb64(nonce).map_err(|_| "invalid_exchange".to_string())?;
        if nonce.len() != 12 {
            return Err("invalid_exchange".into());
        }
        let cipher = Aes256Gcm::new_from_slice(key.as_ref()).expect("32-byte key");
        let aad = format!("{device_id}\n{id}");
        let released = Zeroizing::new(
            cipher
                .decrypt(Nonce::from_slice(&nonce), Payload { msg: &unb64(sealed).map_err(|_| "invalid_exchange".to_string())?, aad: aad.as_bytes() })
                .map_err(|_| "invalid_exchange".to_string())?,
        );
        let file = WrapFile::load(&self.state_dir)?;
        let wrap = file.device(device_id).ok_or("no_wrap")?;
        let k = secrets::unwrap_with_shared(wrap, &released).map_err(|_| "invalid_exchange".to_string())?;
        self.released(&k, devices)
    }

    /// Unlock with the recovery code (every device lost).
    pub fn recover(&self, code: &str, devices: &[DeviceKey]) -> Result<(), String> {
        let file = WrapFile::load(&self.state_dir)?;
        let wrap = file.recovery.as_ref().ok_or("the secrets key is not set up")?;
        let k = secrets::unwrap_with_recovery(wrap, code).map_err(|_| "that recovery code does not fit".to_string())?;
        self.released(&k, devices)
    }

    // ── The sealed credential store ──────────────────────────────────────────

    fn credentials_path(&self) -> PathBuf {
        self.dir().join("credentials.json")
    }

    fn open_credentials(&self, key: &MasterKey) -> Result<HashMap<String, String>, String> {
        let path = self.credentials_path();
        let file: SealedFile = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", path.display()))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
            Err(e) => return Err(format!("{}: {e}", path.display())),
        };
        let sub = Self::subkey(key, "credentials");
        let cipher = Aes256Gcm::new_from_slice(sub.as_ref()).expect("32-byte key");
        let nonce = unb64(&file.nonce)?;
        if nonce.len() != 12 {
            return Err("credentials.json is corrupt".into());
        }
        let plain = Zeroizing::new(
            cipher
                .decrypt(Nonce::from_slice(&nonce), Payload { msg: &unb64(&file.sealed)?, aad: b"credentials" })
                .map_err(|_| "credentials.json does not open with this key".to_string())?,
        );
        serde_json::from_slice(&plain).map_err(|e| e.to_string())
    }

    /// A saved password, while unlocked; `None` when locked (like a locked
    /// OS keyring) or when nothing is saved.
    pub fn credential(&self, account: &str) -> Option<String> {
        let key = self.key()?;
        let mut map = self.open_credentials(&key).ok()?;
        let secret = map.remove(account).filter(|s| !s.is_empty());
        for (_, mut value) in map {
            zeroize::Zeroize::zeroize(&mut value);
        }
        secret
    }

    /// Save (`Some`, non-empty) or forget a password. Refused while locked.
    pub fn set_credential(&self, account: &str, secret: Option<&str>) -> Result<(), String> {
        let key = self.key().ok_or_else(|| concat!("saved passwords are locked until a paired device opens ", crate::app_name!()).to_string())?;
        let _guard = self.files();
        let mut map = self.open_credentials(&key)?;
        if let Some(mut old) = map.remove(account) {
            zeroize::Zeroize::zeroize(&mut old);
        }
        if let Some(secret) = secret.filter(|s| !s.is_empty()) {
            map.insert(account.to_string(), secret.to_string());
        }
        let json = serde_json::to_vec(&map).map_err(|e| e.to_string());
        for (_, mut value) in map {
            zeroize::Zeroize::zeroize(&mut value);
        }
        let plain = Zeroizing::new(json?);
        let sub = Self::subkey(&key, "credentials");
        let cipher = Aes256Gcm::new_from_slice(sub.as_ref()).expect("32-byte key");
        let nonce = random::<12>();
        let sealed = cipher.encrypt(Nonce::from_slice(&nonce), Payload { msg: &plain, aad: b"credentials" }).map_err(|_| "sealing failed".to_string())?;
        crate::services::mobile_control::store::ensure_private_dir(&self.dir())?;
        crate::services::mobile_control::store::write_json_atomic(&self.credentials_path(), &SealedFile { nonce: b64(&nonce), sealed: b64(&sealed) }, 0o600)
    }
}

static VAULT: OnceLock<Vault> = OnceLock::new();

/// Install the daemon's vault (once; a second call keeps the first).
pub fn install(vault: Vault) -> &'static Vault {
    let _ = VAULT.set(vault);
    VAULT.get().expect("just set")
}

/// The daemon's vault; `None` on the desktop.
pub fn vault() -> Option<&'static Vault> {
    VAULT.get()
}

/// The daemon's state dir's secrets directory — for the paths a check reads.
pub fn secrets_dir(state_dir: &Path) -> PathBuf {
    state_dir.join("secrets")
}

#[cfg(test)]
mod tests;

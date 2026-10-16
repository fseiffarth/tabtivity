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
//!   key and once for a recovery code, which is returned once and never
//!   stored. Set-up and a new recovery code need a signature of the
//!   device's pairing key, like enrolment (the route checks it).
//! * **Revoking a device rotates K** ([`rotation`]): a new K, everything
//!   sealed under the old one re-sealed beside it, one atomic switch; locked,
//!   the wrap goes at once and the rotation runs at the next release. The
//!   mail store gets a fresh master key and re-seals its rows in the
//!   background ([`Vault::on_rotate`]), and the Server settings ask for a new
//!   recovery code ([`VaultStatus::new_code_recommended`]).
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
//! * **A lost identity key is re-pinned with the recovery code**
//!   ([`Vault::repin_offer`]): the device checks
//!   [`secrets::identity_binding`] before it trusts a new one.
//!
//! A home directory (or a backup of it) therefore holds the wraps, the
//! identity key and sealed files — nothing that opens without a paired
//! device or the recovery code.

use std::collections::{HashMap, HashSet};
use app_core::sync::LockExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

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

mod rotation;
pub use rotation::revoke_offline;

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
        *self.0.lock_ok() = Some(key.clone());
        Ok(())
    }
    fn get(&self) -> Result<Option<MasterKey>, String> {
        Ok(self.0.lock_ok().clone())
    }
    fn clear(&self) -> Result<(), String> {
        *self.0.lock_ok() = None;
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
    /// K exists.
    pub set_up: bool,
    /// K is in the hold right now.
    pub unlocked: bool,
    /// Devices that can release K.
    pub wrapped_devices: usize,
    /// A recovery code opens the current K (false only after a rotation that
    /// could not carry a v1 recovery wrap along: make a new code).
    pub recovery_code: bool,
    /// A device was revoked since the recovery code was made: make a new
    /// one (user decision 2026-10-03).
    pub new_code_recommended: bool,
}

/// What a device needs to re-pin a changed identity key with the recovery
/// code: the new identity, the recovery wrap's fields and the binding the
/// device recomputes ([`secrets::identity_binding`]).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepinOffer {
    pub identity: String,
    pub salt: String,
    pub public: String,
    pub ephemeral: String,
    pub nonce: String,
    pub sealed: String,
    pub auth_nonce: String,
    pub binding: String,
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
    /// Run after a rotation committed (`on_rotate`).
    rotate_listeners: Mutex<Vec<(&'static str, Listener)>>,
    /// Serializes read-modify-writes of `wraps.json` and `credentials.json`.
    files: Mutex<()>,
    /// Devices revoked while this vault ran. A route reads its device list
    /// before it calls in (a release, an enrolment), so a list read just
    /// before a revoke still names the revoked device: K is never wrapped
    /// for one of these again. After a restart every list is read afresh.
    revoked: Mutex<HashSet<String>>,
}

use crate::clock::now_secs as now;

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
    /// The vault of `state_dir`. Finishes or undoes a rotation a crash
    /// interrupted before anything reads a sealed file ([`Vault::settle`]).
    pub fn new(state_dir: PathBuf, hold: Arc<dyn KeyHold>) -> Self {
        let vault = Self {
            state_dir,
            hold,
            exchanges: Mutex::default(),
            listeners: Mutex::default(),
            rotate_listeners: Mutex::default(),
            files: Mutex::default(),
            revoked: Mutex::default(),
        };
        {
            let _guard = vault.files();
            vault.settle();
        }
        vault
    }

    fn dir(&self) -> PathBuf {
        self.state_dir.join("secrets")
    }

    fn files(&self) -> std::sync::MutexGuard<'_, ()> {
        self.files.lock_ok()
    }

    /// `devices` without any this vault saw revoked.
    fn live(&self, devices: &[DeviceKey]) -> Vec<DeviceKey> {
        let revoked = self.revoked.lock_ok();
        devices.iter().filter(|d| !revoked.contains(&d.id)).cloned().collect()
    }

    fn is_revoked(&self, device_id: &str) -> bool {
        self.revoked.lock_ok().contains(device_id)
    }

    /// K, while unlocked.
    pub fn key(&self) -> Option<MasterKey> {
        self.hold.get().ok().flatten()
    }

    /// Run `f` with K (or `None` while locked) and no rotation in between:
    /// what reads or writes something sealed under K outside this module
    /// (`mail_crypt`'s device mode) goes through here, so it never reads a
    /// file under one K and the key of another. `f` must not call back into
    /// the vault.
    pub fn with_key<R>(&self, f: impl FnOnce(Option<&MasterKey>) -> R) -> R {
        let _guard = self.files();
        let key = self.key();
        f(key.as_ref())
    }

    pub fn is_set_up(&self) -> bool {
        WrapFile::load(&self.state_dir).map(|f| f.is_set_up()).unwrap_or(false)
    }

    pub fn status(&self) -> VaultStatus {
        let file = WrapFile::load(&self.state_dir).unwrap_or_default();
        VaultStatus {
            set_up: file.is_set_up(),
            unlocked: self.key().is_some(),
            wrapped_devices: file.devices.len(),
            recovery_code: file.recovery.is_some(),
            new_code_recommended: file.is_set_up() && file.new_code_recommended,
        }
    }

    /// A key derived from K for one purpose (`"mail-kek"`, `"credentials"`).
    pub fn subkey(key: &MasterKey, purpose: &str) -> Zeroizing<[u8; 32]> {
        secrets::subkey(key, purpose)
    }

    /// Run `f` whenever K is released (by a device or the recovery code), and
    /// once now if it is already in the hold. One listener per `name`.
    pub fn on_unlock(&self, name: &'static str, f: impl Fn() + Send + Sync + 'static) {
        let listener: Listener = Arc::new(f);
        {
            let mut listeners = self.listeners.lock_ok();
            listeners.retain(|(n, _)| *n != name);
            listeners.push((name, listener.clone()));
        }
        if self.key().is_some() {
            listener();
        }
    }

    /// K came back (a device, the recovery code). `devices` is every
    /// enrolled device: a wrap of a device no longer among them (revoked
    /// while no vault saw it, e.g. by `--revoke-device` with the daemon
    /// stopped) is dropped and K rotated, as is a rotation still pending
    /// from a revoke while locked.
    ///
    /// Only the K `wraps.json` names goes into the hold, checked under the
    /// file lock: a wrap read just before a rotation committed (two devices
    /// releasing at once around a pending rotation) opens the retired K,
    /// which would otherwise replace the current one — and a credential
    /// saved then would be sealed under a key nobody holds any more.
    fn released(&self, key: &MasterKey, devices: &[DeviceKey]) -> Result<(), String> {
        {
            let _guard = self.files();
            // A rotation whose files a failure left half moved is finished
            // before K is used (it would otherwise wait for a restart).
            self.settle();
            let file = WrapFile::load(&self.state_dir)?;
            if file.check.as_ref().is_some_and(|check| *check != secrets::key_check(key)) {
                return Err("invalid_exchange".into());
            }
            self.hold.put(key)?;
        }
        self.catch_up(devices);
        self.wrap_missing(devices);
        self.notify();
        Ok(())
    }

    /// Run every unlock listener (K is in the hold).
    fn notify(&self) {
        let listeners: Vec<Listener> = self.listeners.lock_ok().iter().map(|(_, l)| l.clone()).collect();
        for listener in listeners {
            listener();
        }
    }

    /// Run `f` after every rotation that committed (a revoke while unlocked,
    /// a pending one at a release or at daemon start), with the vault's lock
    /// released: the mail store switches to the fresh master key the
    /// rotation put into its `key.json` and re-keys. One listener per `name`.
    pub fn on_rotate(&self, name: &'static str, f: impl Fn() + Send + Sync + 'static) {
        let mut listeners = self.rotate_listeners.lock_ok();
        listeners.retain(|(n, _)| *n != name);
        listeners.push((name, Arc::new(f)));
    }

    fn notify_rotated(&self) {
        let listeners: Vec<Listener> = self.rotate_listeners.lock_ok().iter().map(|(_, l)| l.clone()).collect();
        for listener in listeners {
            listener();
        }
    }

    /// The one mail store a daemon has (`<state>/mail`, as
    /// `commands::mail::mail_dir`), whose device-mode key file a rotation
    /// re-keys.
    pub fn mail_dir(&self) -> PathBuf {
        self.state_dir.join("mail")
    }

    /// Mint K: wraps for every enrolled device, one under a fresh recovery
    /// code, which is returned — once; it is stored nowhere. Refused when K
    /// exists already (that would orphan everything sealed under it).
    pub fn set_up(&self, devices: &[DeviceKey]) -> Result<Zeroizing<String>, String> {
        let guard = self.files();
        // `is_set_up`, not "has a recovery wrap": a rotation that could not
        // carry a v1 wrap along leaves K without one, and a second set-up
        // would orphan everything sealed under it.
        if WrapFile::load(&self.state_dir)?.is_set_up() {
            return Err("the secrets key is set up already".into());
        }
        let key = MasterKey::generate();
        let code = secrets::recovery_code();
        let mut file = WrapFile {
            devices: Vec::new(),
            recovery: Some(secrets::wrap_with_recovery(&key, &code)?),
            kid: Some(rotation::new_kid()),
            check: Some(secrets::key_check(&key)),
            rotate: false,
            new_code_recommended: false,
        };
        for device in &self.live(devices) {
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
        self.notify();
        Ok(code)
    }

    /// While unlocked: a fresh recovery code replaces the old one (the old
    /// wrap is gone, so a lost or leaked code stops working) and clears
    /// "new code recommended". Returned once.
    pub fn new_recovery_code(&self) -> Result<Zeroizing<String>, String> {
        // K read under the lock: one read before a rotation would wrap the
        // retired K for the new code.
        let _guard = self.files();
        let key = self.key().ok_or("the secrets key is locked")?;
        let mut file = WrapFile::load(&self.state_dir)?;
        if !file.is_set_up() {
            return Err("the secrets key is not set up".into());
        }
        let code = secrets::recovery_code();
        file.recovery = Some(secrets::wrap_with_recovery(&key, &code)?);
        // A fresh A: no revoked device knows this code's.
        file.new_code_recommended = false;
        file.save(&self.state_dir)?;
        Ok(code)
    }

    /// While unlocked: wrap K for each device that has none. The count made.
    pub fn wrap_missing(&self, devices: &[DeviceKey]) -> usize {
        let devices = self.live(devices);
        let _guard = self.files();
        let Some(key) = self.key() else { return 0 };
        let Ok(mut file) = WrapFile::load(&self.state_dir) else { return 0 };
        if !file.is_set_up() {
            return 0;
        }
        let mut made = 0;
        for device in &devices {
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

    /// Drop a device's wrap without rotating: it enrolled a new ECDH key, so
    /// the wrap made for the old one can never be opened again.
    pub fn drop_wrap(&self, device_id: &str) {
        let _guard = self.files();
        if let Ok(mut file) = WrapFile::load(&self.state_dir) {
            if file.revoke(device_id) {
                let _ = file.save(&self.state_dir);
            }
        }
    }

    /// Revoking a device (user decision 2026-10-03): its wrap is deleted at
    /// once and K is rotated — now if unlocked, else at the next release —
    /// so a copy of the old `wraps.json` and the device's key open nothing
    /// sealed from then on. `remaining`: every other enrolled device.
    pub fn revoke(&self, device_id: &str, remaining: &[DeviceKey]) -> Result<(), String> {
        self.revoked.lock_ok().insert(device_id.to_string());
        let remaining: Vec<DeviceKey> = remaining.iter().filter(|d| d.id != device_id).cloned().collect();
        self.revoke_where(|w| w.device_id == device_id, &remaining)
    }

    /// Every device forgotten (`device_ids`: every one that was paired):
    /// every device wrap goes and K is rotated; the recovery code follows
    /// the new K.
    pub fn forget_devices(&self, device_ids: &[String]) -> Result<(), String> {
        {
            let mut revoked = self.revoked.lock_ok();
            revoked.extend(device_ids.iter().cloned());
            if let Ok(file) = WrapFile::load(&self.state_dir) {
                revoked.extend(file.devices.iter().map(|w| w.device_id.clone()));
            }
        }
        self.revoke_where(|_| true, &[])
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
                // Two first uses at once (two devices enrolling, an enrolment
                // beside an unlock start): the one that waited must take the
                // key the other just wrote, or a device would pin a key
                // that is then overwritten and never verify an exchange again.
                if let Ok(bytes) = std::fs::read(&path) {
                    let bytes = Zeroizing::new(bytes);
                    return SigningKey::from_slice(&bytes).map_err(|_| "identity.key is not a P-256 key".to_string());
                }
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
        if !file.is_set_up() {
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
        let mut exchanges = self.exchanges.lock_ok();
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
        let exchange = self.exchanges.lock_ok().remove(id).ok_or("invalid_exchange")?;
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

    /// Unlock with the recovery code (every device lost). A v1 recovery
    /// wrap is rewritten as v2 on the way (the code is at hand only now), so
    /// it can follow later rotations and back a re-pin.
    pub fn recover(&self, code: &str, devices: &[DeviceKey]) -> Result<(), String> {
        let k = {
            let _guard = self.files();
            let mut file = WrapFile::load(&self.state_dir)?;
            let wrap = file.recovery.as_ref().ok_or("the secrets key is not set up")?;
            let k = secrets::unwrap_with_recovery(wrap, code).map_err(|_| "that recovery code does not fit".to_string())?;
            if !wrap.is_current() {
                file.recovery = Some(secrets::wrap_with_recovery(&k, code)?);
                file.save(&self.state_dir)?;
            }
            k
        };
        self.released(&k, devices)
    }

    // ── Re-pinning the identity key (user decision 2026-10-03) ───────────────

    /// What a device needs to trust this daemon's identity key again after
    /// `identity.key` was lost and made anew: the device recomputes
    /// `binding` from the recovery code and these fields and pins
    /// `identity` only if it matches. Works locked or unlocked; nothing
    /// secret leaves the daemon (the sealed A stays here, only its nonce goes).
    pub fn repin_offer(&self, origin: &str) -> Result<RepinOffer, String> {
        let file = WrapFile::load(&self.state_dir)?;
        if !file.is_set_up() {
            return Err("not_set_up".into());
        }
        let wrap = file.recovery.as_ref().filter(|w| w.is_current()).ok_or("recovery_outdated")?;
        let (Some(public), Some(ephemeral), Some(auth_nonce), Some(auth)) = (&wrap.public, &wrap.ephemeral, &wrap.auth_nonce, &wrap.auth) else {
            return Err("recovery_outdated".into());
        };
        let identity = self.identity_public()?;
        let binding = secrets::identity_binding(&unb64(auth)?, origin, &identity);
        Ok(RepinOffer {
            identity,
            salt: wrap.salt.clone(),
            public: public.clone(),
            ephemeral: ephemeral.clone(),
            nonce: wrap.nonce.clone(),
            sealed: wrap.sealed.clone(),
            auth_nonce: auth_nonce.clone(),
            binding,
        })
    }

    /// The payload a device signs with its pairing key to set the key up or
    /// make a new recovery code (user decision 2026-10-03): a session cookie
    /// alone is refused.
    pub fn action_payload(origin: &str, device_id: &str, action: &str, nonce: &str, expires_at: u64) -> String {
        format!("{}\n{origin}\n{device_id}\n{action}\n{nonce}\n{expires_at}", secrets::context("action"))
    }

    // ── The sealed credential store ──────────────────────────────────────────

    fn credentials_path(&self) -> PathBuf {
        self.dir().join("credentials.json")
    }

    fn open_credentials(&self, key: &MasterKey) -> Result<HashMap<String, String>, String> {
        Self::open_credentials_at(&self.credentials_path(), key)
    }

    fn open_credentials_at(path: &Path, key: &MasterKey) -> Result<HashMap<String, String>, String> {
        let file: SealedFile = match std::fs::read(path) {
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
        // Not the parser's message: it may quote the decrypted passwords, and
        // callers log this error.
        serde_json::from_slice(&plain).map_err(|_| "credentials.json does not parse".to_string())
    }

    /// A saved password, while unlocked; `None` when locked (like a locked
    /// OS keyring) or when nothing is saved.
    pub fn credential(&self, account: &str) -> Option<String> {
        let _guard = self.files();
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
        // K read under the lock: one read before a rotation would seal a
        // first credential under the retired K, which nothing opens after.
        let _guard = self.files();
        let key = self.key().ok_or_else(|| concat!("saved passwords are locked until a paired device opens ", crate::app_name!()).to_string())?;
        let mut map = self.open_credentials(&key)?;
        if let Some(mut old) = map.remove(account) {
            zeroize::Zeroize::zeroize(&mut old);
        }
        if let Some(secret) = secret.filter(|s| !s.is_empty()) {
            map.insert(account.to_string(), secret.to_string());
        }
        let sealed = Self::seal_credentials(&key, map)?;
        crate::services::mobile_control::store::ensure_private_dir(&self.dir())?;
        crate::services::mobile_control::store::write_json_atomic(&self.credentials_path(), &sealed, 0o600)
    }

    /// The credential map sealed under `subkey(key, "credentials")`; the
    /// map's values are zeroed on the way.
    fn seal_credentials(key: &MasterKey, map: HashMap<String, String>) -> Result<SealedFile, String> {
        let json = serde_json::to_vec(&map).map_err(|e| e.to_string());
        for (_, mut value) in map {
            zeroize::Zeroize::zeroize(&mut value);
        }
        let plain = Zeroizing::new(json?);
        let sub = Self::subkey(key, "credentials");
        let cipher = Aes256Gcm::new_from_slice(sub.as_ref()).expect("32-byte key");
        let nonce = random::<12>();
        let sealed = cipher.encrypt(Nonce::from_slice(&nonce), Payload { msg: &plain, aad: b"credentials" }).map_err(|_| "sealing failed".to_string())?;
        Ok(SealedFile { nonce: b64(&nonce), sealed: b64(&sealed) })
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

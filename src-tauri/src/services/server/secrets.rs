//! The device-released secrets key (hosted plan §6.8, Q5): one master key K
//! per user, never on disk in the clear, wrapped once per paired device and
//! once under a recovery code, held only in memory — the kernel's per-user
//! **persistent keyring**, so it outlives a daemon restart but not a reboot.
//!
//! This module is the cryptographic and keyring half, `AppHandle`-free and
//! unit-tested. The wiring — the device's ECDH key, the unlock exchange,
//! `mail_crypt`'s device-released mode, the sealed password store — is
//! [`super::vault`].
//!
//! * **Wrap for a device:** an ephemeral P-256 key X; `HKDF-SHA256(salt =
//!   X's public key, ikm = ECDH(X, device), info = context ‖ device id)`;
//!   K sealed with AES-256-GCM under it, the device id as AAD. X's secret is
//!   dropped; the wrap keeps X's public key.
//! * **Unwrap:** the device computes `ECDH(device, X)` inside WebCrypto
//!   (`deriveBits`, the x-coordinate, the same 32 bytes as
//!   the shared value's `raw_secret_bytes()`) and hands it back; the daemon runs
//!   the same HKDF and opens the wrap. A disk image holds wraps only; a
//!   stolen device key holds no wrap.
//! * **Recovery code:** 128 random bits shown once as eight groups (the code
//!   is a key, not a password, so no slow KDF is needed). From it and a salt
//!   come a P-256 key `r` (public half `R` kept in the wrap) and an auth key
//!   `A`. K is wrapped **to `R`** like a device wrap, so a rotation of K
//!   (revoking a device) re-wraps the new K for the same code without
//!   knowing it; `A` is kept sealed under K and is what lets a device check
//!   a re-pinned identity key ([`identity_binding`]). A v1 wrap (K sealed
//!   under `HKDF(code)`, from before the rotation) still opens; it cannot
//!   follow a rotation and is upgraded the next time the code is used.

use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64ct::{Base64UrlUnpadded, Encoding};
use hkdf::Hkdf;
use p256::ecdh::EphemeralSecret as Ephemeral;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::PublicKey;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::Zeroizing;

/// Domain separation for every derived key here (and the vault's).
pub(crate) fn context(purpose: &str) -> String {
    format!("{}-secrets-v1:{purpose}", crate::brand::SLUG)
}

/// A 32-byte key derived from K for one purpose (`"mail-kek"`,
/// `"credentials"`, `"check"`, `"recovery-auth"`).
pub fn subkey(key: &MasterKey, purpose: &str) -> Zeroizing<[u8; 32]> {
    derive(b"", key.bytes(), &context(purpose))
}

/// A public fingerprint of K, kept in `wraps.json`: tells which K a held key
/// is (a crash between a rotation's commit and the keyring write leaves the
/// old one held) without saying anything about it.
pub fn key_check(key: &MasterKey) -> String {
    b64(&subkey(key, "check")[..16])
}

/// K. Zeroed on drop.
#[derive(Clone)]
pub struct MasterKey(Zeroizing<[u8; 32]>);

impl MasterKey {
    pub fn generate() -> Self {
        let mut key = Zeroizing::new([0u8; 32]);
        rand::rngs::OsRng.fill_bytes(key.as_mut());
        Self(key)
    }

    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(Zeroizing::new(bytes))
    }

    /// Copy 32 bytes straight into the zeroizing buffer — no array on the
    /// stack in between (P3 review finding 15: `from_bytes(*buf)` left one).
    pub fn from_slice(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() != 32 {
            return Err("not a 32-byte key".into());
        }
        let mut key = Zeroizing::new([0u8; 32]);
        key.copy_from_slice(bytes);
        Ok(Self(key))
    }

    pub fn bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl std::fmt::Debug for MasterKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("MasterKey(…)")
    }
}

/// K sealed for one device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceWrap {
    pub device_id: String,
    /// X's public key, SEC1 uncompressed, base64url.
    pub ephemeral: String,
    pub nonce: String,
    pub sealed: String,
}

/// K sealed for the recovery code.
///
/// v2 (every wrap written now): `salt` derives `r`/`R` and `A` from the code;
/// K is sealed under `HKDF(salt = X, ECDH(X, R), "recovery")`; `auth` is `A`
/// sealed under `subkey(K, "recovery-auth")`. v1 (no `public`): K sealed
/// under `HKDF(salt, code, "recovery")`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecoveryWrap {
    pub salt: String,
    pub nonce: String,
    pub sealed: String,
    /// `R`, SEC1 uncompressed, base64url.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public: Option<String>,
    /// X's public key, SEC1 uncompressed, base64url.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ephemeral: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_nonce: Option<String>,
    /// `A` sealed under `subkey(K, "recovery-auth")` (AAD `recovery-auth`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<String>,
}

impl RecoveryWrap {
    /// Can follow a rotation of K (and back a re-pin): a v2 wrap.
    pub fn is_current(&self) -> bool {
        self.public.is_some() && self.ephemeral.is_some() && self.auth_nonce.is_some() && self.auth.is_some()
    }
}

/// `<state_dir>/secrets/wraps.json` (`0600`): every wrap, nothing in the clear.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WrapFile {
    #[serde(default)]
    pub devices: Vec<DeviceWrap>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery: Option<RecoveryWrap>,
    /// Which K this file wraps (a fresh id per K; absent before rotation).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kid: Option<String>,
    /// [`key_check`] of that K.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check: Option<String>,
    /// A device was revoked while K was locked: rotate at the next release.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub rotate: bool,
    /// A device was revoked since the recovery code was made (user decision
    /// 2026-10-03). The code's A outlives rotations, so a revoked device with
    /// an old `wraps.json` knows it and, from the gateway's position, could
    /// fake a re-pin prompt; the Server settings ask for a new code until one
    /// is made ([`super::vault::Vault::new_recovery_code`] clears it).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub new_code_recommended: bool,
}

impl WrapFile {
    pub fn path_in(state_dir: &Path) -> PathBuf {
        state_dir.join("secrets").join("wraps.json")
    }

    pub fn load(state_dir: &Path) -> Result<Self, String> {
        let path = Self::path_in(state_dir);
        match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(format!("{}: {e}", path.display())),
        }
    }

    pub fn save(&self, state_dir: &Path) -> Result<(), String> {
        self.save_to(&Self::path_in(state_dir))
    }

    /// Write to `path` (a rotation's `wraps.json.next`): atomic, `0600`.
    pub fn save_to(&self, path: &Path) -> Result<(), String> {
        if let Some(dir) = path.parent() {
            crate::services::mobile_control::store::ensure_private_dir(dir)?;
        }
        crate::services::mobile_control::store::write_json_atomic(path, self, 0o600)
    }

    /// Whether a K exists: a recovery wrap, or (after a rotation that could
    /// not carry a v1 recovery wrap along) a key check.
    pub fn is_set_up(&self) -> bool {
        self.recovery.is_some() || self.check.is_some()
    }

    /// Add or replace a device's wrap.
    pub fn put(&mut self, wrap: DeviceWrap) {
        self.devices.retain(|w| w.device_id != wrap.device_id);
        self.devices.push(wrap);
    }

    /// Revoking a device deletes its wrap (§6.8).
    pub fn revoke(&mut self, device_id: &str) -> bool {
        let before = self.devices.len();
        self.devices.retain(|w| w.device_id != device_id);
        before != self.devices.len()
    }

    pub fn device(&self, device_id: &str) -> Option<&DeviceWrap> {
        self.devices.iter().find(|w| w.device_id == device_id)
    }
}

fn b64(bytes: &[u8]) -> String {
    Base64UrlUnpadded::encode_string(bytes)
}

fn unb64(text: &str) -> Result<Vec<u8>, String> {
    Base64UrlUnpadded::decode_vec(text).map_err(|_| "not base64url".to_string())
}

fn derive(salt: &[u8], ikm: &[u8], info: &str) -> Zeroizing<[u8; 32]> {
    let mut out = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(Some(salt), ikm).expand(info.as_bytes(), out.as_mut()).expect("32 bytes is a valid HKDF length");
    out
}

fn seal(key: &[u8; 32], aad: &[u8], plain: &[u8]) -> (String, String) {
    let mut nonce = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let cipher = Aes256Gcm::new_from_slice(key).expect("32-byte key");
    let sealed = cipher.encrypt(Nonce::from_slice(&nonce), Payload { msg: plain, aad }).expect("AES-GCM sealing cannot fail");
    (b64(&nonce), b64(&sealed))
}

fn open_bytes(key: &[u8; 32], aad: &[u8], nonce: &str, sealed: &str) -> Result<Zeroizing<Vec<u8>>, String> {
    let nonce = unb64(nonce)?;
    if nonce.len() != 12 {
        return Err("bad nonce".into());
    }
    let cipher = Aes256Gcm::new_from_slice(key).expect("32-byte key");
    Ok(Zeroizing::new(cipher.decrypt(Nonce::from_slice(&nonce), Payload { msg: &unb64(sealed)?, aad }).map_err(|_| "the wrap does not open with this key".to_string())?))
}

fn open(key: &[u8; 32], aad: &[u8], nonce: &str, sealed: &str) -> Result<MasterKey, String> {
    MasterKey::from_slice(&open_bytes(key, aad, nonce, sealed)?)
}

/// A device's public ECDH key as the browser exports it (`raw`, SEC1
/// uncompressed, base64url).
pub fn device_key(raw_b64: &str) -> Result<PublicKey, String> {
    PublicKey::from_sec1_bytes(&unb64(raw_b64)?).map_err(|_| "not a P-256 public key".to_string())
}

/// Seal K for `device_id`'s ECDH key.
pub fn wrap_for_device(key: &MasterKey, device_id: &str, device: &PublicKey) -> DeviceWrap {
    let x = Ephemeral::random(&mut rand::rngs::OsRng);
    let x_public = x.public_key().to_encoded_point(false);
    let shared = x.diffie_hellman(device);
    let kek = derive(x_public.as_bytes(), shared.raw_secret_bytes(), &format!("{}{device_id}", context("device")));
    let (nonce, sealed) = seal(&kek, device_id.as_bytes(), key.bytes());
    DeviceWrap { device_id: device_id.into(), ephemeral: b64(x_public.as_bytes()), nonce, sealed }
}

/// Open a device's wrap with the shared secret the device computed
/// (`ECDH(device, X)`, 32 bytes).
pub fn unwrap_with_shared(wrap: &DeviceWrap, shared: &[u8]) -> Result<MasterKey, String> {
    if shared.len() != 32 {
        return Err("the shared secret is 32 bytes".into());
    }
    let kek = derive(&unb64(&wrap.ephemeral)?, shared, &format!("{}{}", context("device"), wrap.device_id));
    open(&kek, wrap.device_id.as_bytes(), &wrap.nonce, &wrap.sealed)
}

/// A fresh recovery code: 128 bits as eight groups of four hex digits,
/// zeroized when dropped (it opens K).
pub fn recovery_code() -> Zeroizing<String> {
    let mut bytes = Zeroizing::new([0u8; 16]);
    rand::rngs::OsRng.fill_bytes(bytes.as_mut());
    let mut code = Zeroizing::new(String::with_capacity(39));
    for (i, b) in bytes.iter().enumerate() {
        if i > 0 && i % 2 == 0 {
            code.push('-');
        }
        code.push(char::from_digit(u32::from(b >> 4), 16).unwrap_or('0'));
        code.push(char::from_digit(u32::from(b & 0xf), 16).unwrap_or('0'));
    }
    code
}

fn normalize_code(code: &str) -> Result<Zeroizing<Vec<u8>>, String> {
    let hex: String = code.chars().filter(|c| c.is_ascii_hexdigit()).map(|c| c.to_ascii_lowercase()).collect();
    if hex.len() != 32 {
        return Err("a recovery code has 32 hex digits".into());
    }
    Ok(Zeroizing::new(hex.into_bytes()))
}

/// The code's P-256 key `r`: `HKDF(salt, code, "recovery-scalar")`, the
/// first of `…`, `…1`, `…2` that is a valid scalar (all but 2⁻³² of codes
/// take the first). `mobile-web/src/secretsCore.ts` derives the same.
fn recovery_scalar(code: &[u8], salt: &[u8]) -> Result<p256::SecretKey, String> {
    for round in 0..8u8 {
        let info = if round == 0 { context("recovery-scalar") } else { format!("{}{round}", context("recovery-scalar")) };
        let bytes = derive(salt, code, &info);
        if let Ok(key) = p256::SecretKey::from_bytes(p256::FieldBytes::from_slice(bytes.as_ref())) {
            return Ok(key);
        }
    }
    Err("no recovery key for this code".into())
}

/// The code's auth key `A`.
fn recovery_auth_key(code: &[u8], salt: &[u8]) -> Zeroizing<[u8; 32]> {
    derive(salt, code, &context("recovery-auth-key"))
}

/// Seal `key` to `R`, and `auth` (`A`) under `key`.
fn seal_recovery(key: &MasterKey, salt: &[u8], public: &PublicKey, auth: &[u8; 32]) -> RecoveryWrap {
    let x = Ephemeral::random(&mut rand::rngs::OsRng);
    let x_public = x.public_key().to_encoded_point(false);
    let shared = x.diffie_hellman(public);
    let kek = derive(x_public.as_bytes(), shared.raw_secret_bytes(), &context("recovery"));
    let (nonce, sealed) = seal(&kek, b"recovery", key.bytes());
    let (auth_nonce, auth) = seal(&subkey(key, "recovery-auth"), b"recovery-auth", auth);
    RecoveryWrap {
        salt: b64(salt),
        nonce,
        sealed,
        public: Some(b64(public.to_encoded_point(false).as_bytes())),
        ephemeral: Some(b64(x_public.as_bytes())),
        auth_nonce: Some(auth_nonce),
        auth: Some(auth),
    }
}

pub fn wrap_with_recovery(key: &MasterKey, code: &str) -> Result<RecoveryWrap, String> {
    let code = normalize_code(code)?;
    let mut salt = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    let r = recovery_scalar(&code, &salt)?;
    Ok(seal_recovery(key, &salt, &r.public_key(), &recovery_auth_key(&code, &salt)))
}

/// The same code's wrap for a new K (a rotation): needs the old K (to open
/// `A`), never the code. A v1 wrap cannot follow.
pub fn rewrap_recovery(wrap: &RecoveryWrap, old: &MasterKey, new: &MasterKey) -> Result<RecoveryWrap, String> {
    let (Some(public), Some(auth_nonce), Some(auth)) = (&wrap.public, &wrap.auth_nonce, &wrap.auth) else {
        return Err("a v1 recovery wrap cannot follow a new key".into());
    };
    let public = PublicKey::from_sec1_bytes(&unb64(public)?).map_err(|_| "the recovery wrap is corrupt".to_string())?;
    let a = open_bytes(&subkey(old, "recovery-auth"), b"recovery-auth", auth_nonce, auth)?;
    let a: &[u8; 32] = a.as_slice().try_into().map_err(|_| "the recovery wrap is corrupt".to_string())?;
    Ok(seal_recovery(new, &unb64(&wrap.salt)?, &public, a))
}

pub fn unwrap_with_recovery(wrap: &RecoveryWrap, code: &str) -> Result<MasterKey, String> {
    let code = normalize_code(code)?;
    let salt = unb64(&wrap.salt)?;
    let Some(ephemeral) = &wrap.ephemeral else {
        // v1.
        let kek = derive(&salt, &code, &context("recovery"));
        return open(&kek, b"recovery", &wrap.nonce, &wrap.sealed);
    };
    let r = recovery_scalar(&code, &salt)?;
    let x = PublicKey::from_sec1_bytes(&unb64(ephemeral)?).map_err(|_| "the recovery wrap is corrupt".to_string())?;
    let shared = p256::ecdh::diffie_hellman(r.to_nonzero_scalar(), x.as_affine());
    let kek = derive(&unb64(ephemeral)?, shared.raw_secret_bytes(), &context("recovery"));
    open(&kek, b"recovery", &wrap.nonce, &wrap.sealed)
}

/// What a device checks before it re-pins a changed identity key (user
/// decision 2026-10-03): `HKDF(ikm = the sealed A, info = context("identity")
/// ‖ origin ‖ identity)`. The daemon computes it from its `wraps.json`
/// without K; a device computes the sealed A itself from the recovery code
/// (→ `r` → K, and `A`) and the wrap's public fields. Someone who has
/// neither the code nor the daemon's `wraps.json` (a gateway in the middle)
/// cannot make one for a key of its own.
pub fn identity_binding(sealed_auth: &[u8], origin: &str, identity: &str) -> String {
    b64(derive(b"", sealed_auth, &format!("{}\n{origin}\n{identity}", context("identity"))).as_ref())
}

/// The device's side of a re-pin, as `mobile-web/src/secretsCore.ts`
/// `checkRepin` does it in WebCrypto: from the code and the offer's public
/// fields, K (through `r`) and A, then the sealed A as the daemon holds it
/// (AES-GCM is deterministic given key and nonce), then the binding. True
/// only if `binding` matches for `identity`. The daemon never runs this; the
/// tests and the shared vector do.
#[allow(clippy::too_many_arguments)]
pub fn check_repin(code: &str, salt: &str, ephemeral: &str, nonce: &str, sealed: &str, auth_nonce: &str, origin: &str, identity: &str, binding: &str) -> bool {
    let wrap = RecoveryWrap {
        salt: salt.into(),
        nonce: nonce.into(),
        sealed: sealed.into(),
        public: None,
        ephemeral: Some(ephemeral.into()),
        auth_nonce: None,
        auth: None,
    };
    let Ok(k) = unwrap_with_recovery(&wrap, code) else { return false };
    let (Ok(code), Ok(salt), Ok(auth_nonce)) = (normalize_code(code), unb64(salt), unb64(auth_nonce)) else { return false };
    if auth_nonce.len() != 12 {
        return false;
    }
    let a = recovery_auth_key(&code, &salt);
    let cipher = Aes256Gcm::new_from_slice(subkey(&k, "recovery-auth").as_ref()).expect("32-byte key");
    let Ok(sealed_auth) = cipher.encrypt(Nonce::from_slice(&auth_nonce), Payload { msg: a.as_ref(), aad: b"recovery-auth" }) else { return false };
    identity_binding(&sealed_auth, origin, identity) == binding
}

/// A v1 recovery wrap (K under `HKDF(salt, code)`), as builds before the
/// rotation wrote it — for the upgrade tests.
#[cfg(test)]
pub(crate) fn wrap_with_recovery_v1(key: &MasterKey, code: &str) -> RecoveryWrap {
    let code = normalize_code(code).expect("a code");
    let salt = [3u8; 16];
    let kek = derive(&salt, &code, &context("recovery"));
    let (nonce, sealed) = seal(&kek, b"recovery", key.bytes());
    RecoveryWrap { salt: b64(&salt), nonce, sealed, public: None, ephemeral: None, auth_nonce: None, auth: None }
}

/// K in the kernel's per-user persistent keyring (`KEYCTL_GET_PERSISTENT`):
/// shared by this uid's processes, gone at reboot or after the keyring's
/// expiry, never written to disk. Fenced agents cannot reach it: the fence's
/// seccomp filter refuses `keyctl` and `add_key`.
#[cfg(target_os = "linux")]
pub mod keyring {
    use super::MasterKey;

    const KEYCTL_GET_PERSISTENT: libc::c_long = 22;
    const KEYCTL_SEARCH: libc::c_long = 10;
    const KEYCTL_READ: libc::c_long = 11;
    const KEYCTL_INVALIDATE: libc::c_long = 21;
    const KEY_SPEC_PROCESS_KEYRING: libc::c_long = -2;

    /// The key's description in the keyring.
    pub fn description() -> String {
        format!("{}:secrets-key", crate::brand::SLUG)
    }

    fn last_error() -> String {
        std::io::Error::last_os_error().to_string()
    }

    fn persistent() -> Result<libc::c_long, String> {
        // SAFETY: keyctl(KEYCTL_GET_PERSISTENT, uid = -1 (own), dest) reads no memory.
        let id = unsafe { libc::syscall(libc::SYS_keyctl, KEYCTL_GET_PERSISTENT, -1 as libc::c_long, KEY_SPEC_PROCESS_KEYRING) };
        if id < 0 {
            return Err(format!("persistent keyring: {}", last_error()));
        }
        Ok(id)
    }

    fn search(keyring: libc::c_long, desc: &std::ffi::CStr) -> Option<libc::c_long> {
        // SAFETY: both strings are NUL-terminated and outlive the call.
        let id = unsafe { libc::syscall(libc::SYS_keyctl, KEYCTL_SEARCH, keyring, c"user".as_ptr(), desc.as_ptr(), 0 as libc::c_long) };
        (id >= 0).then_some(id)
    }

    /// Store K (replacing any earlier one).
    pub fn store(key: &MasterKey) -> Result<(), String> {
        store_as(&description(), key)
    }

    /// K, if this uid's persistent keyring holds it.
    pub fn load() -> Result<Option<MasterKey>, String> {
        load_as(&description())
    }

    /// Forget K (a lock, a revoke of everything).
    pub fn clear() -> Result<(), String> {
        clear_as(&description())
    }

    pub(super) fn store_as(description: &str, key: &MasterKey) -> Result<(), String> {
        let ring = persistent()?;
        let desc = std::ffi::CString::new(description).map_err(|e| e.to_string())?;
        // SAFETY: the payload pointer and length describe `key`'s 32 bytes.
        let id = unsafe { libc::syscall(libc::SYS_add_key, c"user".as_ptr(), desc.as_ptr(), key.bytes().as_ptr(), 32 as libc::size_t, ring) };
        if id < 0 {
            return Err(format!("add_key: {}", last_error()));
        }
        Ok(())
    }

    pub(super) fn load_as(description: &str) -> Result<Option<MasterKey>, String> {
        let ring = persistent()?;
        let desc = std::ffi::CString::new(description).map_err(|e| e.to_string())?;
        let Some(id) = search(ring, &desc) else { return Ok(None) };
        // Read straight into the key's own zeroizing buffer: no copy.
        let mut key = MasterKey::from_bytes([0u8; 32]);
        // SAFETY: the buffer has room for the 32 bytes asked for.
        let n = unsafe { libc::syscall(libc::SYS_keyctl, KEYCTL_READ, id, key.0.as_mut_ptr(), 32 as libc::size_t) };
        if n != 32 {
            return Err(format!("keyctl read: {}", if n < 0 { last_error() } else { format!("{n} bytes") }));
        }
        Ok(Some(key))
    }

    pub(super) fn clear_as(description: &str) -> Result<(), String> {
        let ring = persistent()?;
        let desc = std::ffi::CString::new(description).map_err(|e| e.to_string())?;
        if let Some(id) = search(ring, &desc) {
            // SAFETY: invalidating a key id reads no memory.
            if unsafe { libc::syscall(libc::SYS_keyctl, KEYCTL_INVALIDATE, id) } < 0 {
                return Err(format!("keyctl invalidate: {}", last_error()));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::SecretKey;

    /// What the browser does: its own ECDH secret with the wrap's X.
    fn device_shared(device: &SecretKey, wrap: &DeviceWrap) -> Vec<u8> {
        let x = PublicKey::from_sec1_bytes(&unb64(&wrap.ephemeral).unwrap()).unwrap();
        p256::ecdh::diffie_hellman(device.to_nonzero_scalar(), x.as_affine()).raw_secret_bytes().to_vec()
    }

    #[test]
    fn only_the_device_a_wrap_was_made_for_opens_it() {
        let k = MasterKey::generate();
        let phone = SecretKey::random(&mut rand::rngs::OsRng);
        let laptop = SecretKey::random(&mut rand::rngs::OsRng);
        let raw = b64(phone.public_key().to_encoded_point(false).as_bytes());
        let wrap = wrap_for_device(&k, "dev_phone_0001", &device_key(&raw).unwrap());
        assert!(!wrap.sealed.is_empty() && !serde_json::to_string(&wrap).unwrap().contains(&b64(k.bytes())));
        let opened = unwrap_with_shared(&wrap, &device_shared(&phone, &wrap)).unwrap();
        assert_eq!(opened.bytes(), k.bytes());
        assert!(unwrap_with_shared(&wrap, &device_shared(&laptop, &wrap)).is_err(), "another device's secret");
        let mut moved = wrap.clone();
        moved.device_id = "dev_laptop_001".into();
        assert!(unwrap_with_shared(&moved, &device_shared(&phone, &wrap)).is_err(), "a wrap is bound to its device id");
        assert!(unwrap_with_shared(&wrap, &[0u8; 31]).is_err());
        assert!(device_key("bm90IGEga2V5").is_err());
    }

    #[test]
    fn the_recovery_code_opens_its_wrap_and_nothing_else() {
        let k = MasterKey::generate();
        let code = recovery_code();
        assert_eq!(code.len(), 39, "{}", code.as_str());
        let wrap = wrap_with_recovery(&k, &code).unwrap();
        assert!(code.chars().all(|c| c == '-' || c.is_ascii_hexdigit()), "{}", code.as_str());
        assert_eq!(unwrap_with_recovery(&wrap, &code.to_uppercase().replace('-', " ")).unwrap().bytes(), k.bytes(), "case and separators do not matter");
        assert!(unwrap_with_recovery(&wrap, &recovery_code()).is_err());
        assert!(unwrap_with_recovery(&wrap, "1234").is_err());
    }

    #[test]
    fn the_wrap_file_is_private_and_revoking_deletes_the_wrap() {
        let dir = tempfile::tempdir().unwrap();
        let k = MasterKey::generate();
        let phone = SecretKey::random(&mut rand::rngs::OsRng);
        let mut file = WrapFile::default();
        file.put(wrap_for_device(&k, "dev_phone_0001", &phone.public_key()));
        file.recovery = Some(wrap_with_recovery(&k, &recovery_code()).unwrap());
        file.save(dir.path()).unwrap();
        let text = std::fs::read_to_string(WrapFile::path_in(dir.path())).unwrap();
        assert!(!text.contains(&b64(k.bytes())), "K never in the clear");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(WrapFile::path_in(dir.path())).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let mut back = WrapFile::load(dir.path()).unwrap();
        assert_eq!(back, file);
        assert!(back.revoke("dev_phone_0001") && back.device("dev_phone_0001").is_none());
        assert!(!back.revoke("dev_phone_0001"));
    }

    #[test]
    fn the_recovery_code_follows_a_new_key_without_being_known() {
        let k1 = MasterKey::generate();
        let code = recovery_code();
        let wrap = wrap_with_recovery(&k1, &code).unwrap();
        assert!(wrap.is_current());
        let k2 = MasterKey::generate();
        let next = rewrap_recovery(&wrap, &k1, &k2).unwrap();
        assert_eq!(next.public, wrap.public, "the same code key R");
        assert_eq!(next.salt, wrap.salt);
        assert_eq!(unwrap_with_recovery(&next, &code).unwrap().bytes(), k2.bytes(), "the same code opens the new K");
        assert!(rewrap_recovery(&wrap, &k2, &k1).is_err(), "only the K it was sealed under re-wraps it");
        assert!(unwrap_with_recovery(&next, &recovery_code()).is_err());
        // v1 still opens; it cannot follow a rotation.
        let v1 = wrap_with_recovery_v1(&k1, &code);
        assert!(!v1.is_current());
        assert_eq!(unwrap_with_recovery(&v1, &code).unwrap().bytes(), k1.bytes());
        assert!(rewrap_recovery(&v1, &k1, &k2).is_err());
    }

    #[test]
    fn only_the_code_and_the_daemons_wraps_make_an_identity_binding() {
        let k = MasterKey::generate();
        let code = recovery_code();
        let wrap = wrap_with_recovery(&k, &code).unwrap();
        let origin = "https://desk.example.ts.net";
        let binding = identity_binding(&unb64(wrap.auth.as_ref().unwrap()).unwrap(), origin, "NEW_IDENTITY");
        let check = |code: &str, identity: &str, binding: &str| {
            check_repin(code, &wrap.salt, wrap.ephemeral.as_ref().unwrap(), &wrap.nonce, &wrap.sealed, wrap.auth_nonce.as_ref().unwrap(), origin, identity, binding)
        };
        assert!(check(&code, "NEW_IDENTITY", &binding));
        assert!(!check(&recovery_code(), "NEW_IDENTITY", &binding), "another code");
        assert!(!check(&code, "GATEWAY_IDENTITY", &binding), "the binding names one identity");
        assert!(!check_repin(&code, &wrap.salt, wrap.ephemeral.as_ref().unwrap(), &wrap.nonce, &wrap.sealed, wrap.auth_nonce.as_ref().unwrap(), "https://other.example", "NEW_IDENTITY", &binding));
        // Someone in the middle wraps a key of its own to R (public) and
        // binds its identity: without A it cannot make the sealed A the
        // device recomputes, so the binding fails.
        let evil = MasterKey::generate();
        let r = PublicKey::from_sec1_bytes(&unb64(wrap.public.as_ref().unwrap()).unwrap()).unwrap();
        let forged = seal_recovery(&evil, &unb64(&wrap.salt).unwrap(), &r, &[9u8; 32]);
        let forged_binding = identity_binding(&unb64(forged.auth.as_ref().unwrap()).unwrap(), origin, "GATEWAY_IDENTITY");
        assert!(!check_repin(&code, &forged.salt, forged.ephemeral.as_ref().unwrap(), &forged.nonce, &forged.sealed, forged.auth_nonce.as_ref().unwrap(), origin, "GATEWAY_IDENTITY", &forged_binding));
    }

    /// The keyring round trip where the kernel lets this process use it. In
    /// a fenced agent tab `keyctl` is refused by seccomp (§6.8: "a fenced tab
    /// can't read the keyring entry") — then this records that and passes.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_key_round_trips_through_the_persistent_keyring_when_reachable() {
        // Never the real description: a test must not touch a deployment's key.
        let desc = format!("{}-test-{}", keyring::description(), std::process::id());
        let k = MasterKey::generate();
        match keyring::store_as(&desc, &k) {
            Ok(()) => {
                let back = keyring::load_as(&desc).unwrap().expect("stored");
                assert_eq!(back.bytes(), k.bytes());
                keyring::clear_as(&desc).unwrap();
                assert!(keyring::load_as(&desc).unwrap().is_none());
            }
            Err(error) => eprintln!("persistent keyring unreachable here ({error}); a fenced tab is expected to see this"),
        }
    }
}

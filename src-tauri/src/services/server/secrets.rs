//! The device-released secrets key (hosted plan §6.8, Q5): one master key K
//! per user, never on disk in the clear, wrapped once per paired device and
//! once under a recovery code, held only in memory — the kernel's per-user
//! **persistent keyring**, so it outlives a daemon restart but not a reboot.
//!
//! This module is the cryptographic and keyring half, `AppHandle`-free and
//! unit-tested. The other half — the device's ECDH key made at pairing, the
//! unlock exchange on connect, `mail_crypt` taking K as its KEK in a
//! device-released mode, the sealed opt-in password store — is wired by a
//! later step (`docs/hosted_handoff.md` § P3, TODO group Z).
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
//! * **Recovery code:** 128 random bits shown once as eight groups; K is
//!   sealed under `HKDF(code)` (the code is a key, not a password, so no
//!   slow KDF is needed).

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
use zeroize::{Zeroize, Zeroizing};

/// Domain separation for every derived key here.
fn context(purpose: &str) -> String {
    format!("{}-secrets-v1:{purpose}", crate::brand::SLUG)
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

/// K sealed under the recovery code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecoveryWrap {
    pub salt: String,
    pub nonce: String,
    pub sealed: String,
}

/// `<state_dir>/secrets/wraps.json` (`0600`): every wrap, nothing in the clear.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WrapFile {
    #[serde(default)]
    pub devices: Vec<DeviceWrap>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery: Option<RecoveryWrap>,
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
        let path = Self::path_in(state_dir);
        if let Some(dir) = path.parent() {
            crate::services::mobile_control::store::ensure_private_dir(dir)?;
        }
        crate::services::mobile_control::store::write_json_atomic(&path, self, 0o600)
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

fn open(key: &[u8; 32], aad: &[u8], nonce: &str, sealed: &str) -> Result<MasterKey, String> {
    let nonce = unb64(nonce)?;
    if nonce.len() != 12 {
        return Err("bad nonce".into());
    }
    let cipher = Aes256Gcm::new_from_slice(key).expect("32-byte key");
    let mut plain = cipher.decrypt(Nonce::from_slice(&nonce), Payload { msg: &unb64(sealed)?, aad }).map_err(|_| "the wrap does not open with this key".to_string())?;
    let result = <[u8; 32]>::try_from(plain.as_slice()).map(MasterKey::from_bytes).map_err(|_| "not a 32-byte key".to_string());
    plain.zeroize();
    result
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

/// A fresh recovery code: 128 bits as eight groups of four hex digits.
pub fn recovery_code() -> String {
    let mut bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let code = hex.as_bytes().chunks(4).map(|c| std::str::from_utf8(c).unwrap_or_default()).collect::<Vec<_>>().join("-");
    bytes.zeroize();
    code
}

fn normalize_code(code: &str) -> Result<Zeroizing<Vec<u8>>, String> {
    let hex: String = code.chars().filter(|c| c.is_ascii_hexdigit()).map(|c| c.to_ascii_lowercase()).collect();
    if hex.len() != 32 {
        return Err("a recovery code has 32 hex digits".into());
    }
    Ok(Zeroizing::new(hex.into_bytes()))
}

pub fn wrap_with_recovery(key: &MasterKey, code: &str) -> Result<RecoveryWrap, String> {
    let code = normalize_code(code)?;
    let mut salt = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    let kek = derive(&salt, &code, &context("recovery"));
    let (nonce, sealed) = seal(&kek, b"recovery", key.bytes());
    Ok(RecoveryWrap { salt: b64(&salt), nonce, sealed })
}

pub fn unwrap_with_recovery(wrap: &RecoveryWrap, code: &str) -> Result<MasterKey, String> {
    let code = normalize_code(code)?;
    let kek = derive(&unb64(&wrap.salt)?, &code, &context("recovery"));
    open(&kek, b"recovery", &wrap.nonce, &wrap.sealed)
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
        let mut buf = zeroize::Zeroizing::new([0u8; 32]);
        // SAFETY: `buf` has room for the 32 bytes asked for.
        let n = unsafe { libc::syscall(libc::SYS_keyctl, KEYCTL_READ, id, buf.as_mut_ptr(), 32 as libc::size_t) };
        if n != 32 {
            return Err(format!("keyctl read: {}", if n < 0 { last_error() } else { format!("{n} bytes") }));
        }
        Ok(Some(MasterKey::from_bytes(*buf)))
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
        assert_eq!(code.len(), 39, "{code}");
        let wrap = wrap_with_recovery(&k, &code).unwrap();
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

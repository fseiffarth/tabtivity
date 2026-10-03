//! The §11 secrets tests (TODO #2350): K opens only after a device releases
//! it; it survives a daemon restart, not a keyring flush; a copy of the home
//! cannot open anything; the recovery code can.

use super::*;
use p256::SecretKey;

const ORIGIN: &str = "https://desk.example.ts.net";

/// A paired device as the browser holds it: the ECDH secret (WebCrypto,
/// non-extractable there) and the pinned identity.
struct Device {
    id: String,
    ecdh: SecretKey,
}

impl Device {
    fn new(id: &str) -> Self {
        Self { id: id.into(), ecdh: SecretKey::random(&mut rand::rngs::OsRng) }
    }

    fn key(&self) -> DeviceKey {
        DeviceKey { id: self.id.clone(), ecdh: b64(self.ecdh.public_key().to_encoded_point(false).as_bytes()) }
    }

    /// The device's half of the exchange, step for step as `secretsRelease.ts`.
    fn answer(&self, identity_spki: &str, start: &UnlockStart) -> (String, String, String, String) {
        let UnlockStart::Locked { id, payload, ephemeral, transport, signature } = start else { panic!("not locked: {start:?}") };
        let identity = VerifyingKey::from(PublicKey::from_public_key_der(&unb64(identity_spki).unwrap()).unwrap());
        identity.verify(payload.as_bytes(), &Signature::from_slice(&unb64(signature).unwrap()).unwrap()).expect("signed by the pinned identity");
        let lines: Vec<&str> = payload.split('\n').collect();
        assert_eq!(lines, [secrets::context("unlock").as_str(), ORIGIN, self.id.as_str(), id.as_str(), ephemeral.as_str(), transport.as_str()]);
        let x = PublicKey::from_sec1_bytes(&unb64(ephemeral).unwrap()).unwrap();
        let released = p256::ecdh::diffie_hellman(self.ecdh.to_nonzero_scalar(), x.as_affine());
        let t = SecretKey::random(&mut rand::rngs::OsRng);
        let t_raw = t.public_key().to_encoded_point(false).as_bytes().to_vec();
        let e_raw = unb64(transport).unwrap();
        let e = PublicKey::from_sec1_bytes(&e_raw).unwrap();
        let shared = p256::ecdh::diffie_hellman(t.to_nonzero_scalar(), e.as_affine());
        let mut salt = e_raw.clone();
        salt.extend_from_slice(&t_raw);
        let key = hkdf32(&salt, shared.raw_secret_bytes(), &format!("{}{id}", secrets::context("transport")));
        let nonce = random::<12>();
        let cipher = Aes256Gcm::new_from_slice(key.as_ref()).unwrap();
        let aad = format!("{}\n{id}", self.id);
        let sealed = cipher.encrypt(Nonce::from_slice(&nonce), Payload { msg: released.raw_secret_bytes().as_slice(), aad: aad.as_bytes() }).unwrap();
        (id.clone(), b64(&t_raw), b64(&nonce), b64(&sealed))
    }
}

fn vault_in(dir: &Path, hold: Arc<MemoryHold>) -> Vault {
    Vault::new(dir.to_path_buf(), hold)
}

fn release(vault: &Vault, device: &Device) -> Result<(), String> {
    let identity = vault.identity_public().unwrap();
    let start = vault.start_unlock(ORIGIN, &device.id).unwrap();
    let (id, t, nonce, sealed) = device.answer(&identity, &start);
    vault.finish_unlock(&device.id, &id, &t, &nonce, &sealed, &[device.key()])
}

#[test]
fn k_opens_only_after_a_device_releases_it_and_survives_a_restart_not_a_flush() {
    let dir = tempfile::tempdir().unwrap();
    let hold = Arc::new(MemoryHold::default());
    let phone = Device::new("dev_phone_000001");
    let vault = vault_in(dir.path(), hold.clone());
    assert_eq!(vault.start_unlock(ORIGIN, &phone.id).unwrap(), UnlockStart::NotSetUp);
    let code = vault.set_up(&[phone.key()]).unwrap();
    assert_eq!(code.len(), 39);
    let k = vault.key().expect("held after set-up");
    assert_eq!(vault.status(), VaultStatus { set_up: true, unlocked: true, wrapped_devices: 1 });
    assert!(vault.set_up(&[phone.key()]).is_err(), "never a second K over the first");
    vault.set_credential("imap:alice@mail.example", Some("hunter2")).unwrap();

    // A daemon restart: a new process, the same keyring.
    let restarted = vault_in(dir.path(), hold.clone());
    assert_eq!(restarted.key().unwrap().bytes(), k.bytes());
    assert_eq!(restarted.credential("imap:alice@mail.example").as_deref(), Some("hunter2"));
    assert_eq!(restarted.start_unlock(ORIGIN, &phone.id).unwrap(), UnlockStart::Unlocked);

    // A reboot (the keyring flushed): locked until the phone releases K.
    hold.clear().unwrap();
    assert!(restarted.key().is_none());
    assert_eq!(restarted.credential("imap:alice@mail.example"), None, "locked reads like nothing saved");
    assert!(restarted.set_credential("smtp:x", Some("y")).is_err(), "and refuses writes");
    let fired = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = fired.clone();
    restarted.on_unlock("test", move || {
        counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    });
    assert_eq!(fired.load(std::sync::atomic::Ordering::SeqCst), 0, "not while locked");
    release(&restarted, &phone).unwrap();
    assert_eq!(restarted.key().unwrap().bytes(), k.bytes());
    assert_eq!(fired.load(std::sync::atomic::Ordering::SeqCst), 1, "the listener ran on release");
    assert_eq!(restarted.credential("imap:alice@mail.example").as_deref(), Some("hunter2"));
}

#[test]
fn a_copy_of_the_home_opens_nothing_and_the_recovery_code_does() {
    let dir = tempfile::tempdir().unwrap();
    let phone = Device::new("dev_phone_000001");
    let vault = vault_in(dir.path(), Arc::new(MemoryHold::default()));
    let code = vault.set_up(&[phone.key()]).unwrap();
    vault.set_credential("ssh:alice@host.example:22", Some("s3cret")).unwrap();
    vault.identity_public().unwrap();
    // Nothing on disk holds K or the password in the clear.
    let k = vault.key().unwrap();
    for entry in walk(dir.path()) {
        let bytes = std::fs::read(&entry).unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(!text.contains("s3cret") && !text.contains(&b64(k.bytes())), "{}", entry.display());
        assert!(!bytes.windows(32).any(|w| w == k.bytes()), "{}", entry.display());
    }
    // The backup: the whole state dir, another machine's (empty) keyring.
    let copy = tempfile::tempdir().unwrap();
    copy_tree(dir.path(), copy.path());
    let thief = vault_in(copy.path(), Arc::new(MemoryHold::default()));
    assert_eq!(thief.status(), VaultStatus { set_up: true, unlocked: false, wrapped_devices: 1 });
    assert_eq!(thief.credential("ssh:alice@host.example:22"), None);
    // A device key the thief made up has no wrap; the right device's wrap
    // needs that device's secret.
    let stranger = Device::new("dev_stranger_001");
    assert_eq!(thief.start_unlock(ORIGIN, &stranger.id).unwrap(), UnlockStart::NoWrap);
    let impostor = Device { id: phone.id.clone(), ecdh: SecretKey::random(&mut rand::rngs::OsRng) };
    assert!(release(&thief, &impostor).is_err(), "the wrap opens only with the phone's secret");
    assert!(thief.recover(&secrets::recovery_code(), &[]).is_err());
    thief.recover(&code, &[]).unwrap();
    assert_eq!(thief.credential("ssh:alice@host.example:22").as_deref(), Some("s3cret"), "the recovery code does");
    // A new code retires the old one.
    let fresh = vault.new_recovery_code().unwrap();
    let after = vault_in(dir.path(), Arc::new(MemoryHold::default()));
    assert!(after.recover(&code, &[]).is_err(), "the old code no longer opens it");
    after.recover(&fresh, &[]).unwrap();
}

#[test]
fn an_exchange_is_single_use_and_bound_to_its_device() {
    let dir = tempfile::tempdir().unwrap();
    let hold = Arc::new(MemoryHold::default());
    let phone = Device::new("dev_phone_000001");
    let laptop = Device::new("dev_laptop_00001");
    let vault = vault_in(dir.path(), hold.clone());
    vault.set_up(&[phone.key(), laptop.key()]).unwrap();
    hold.clear().unwrap();
    let identity = vault.identity_public().unwrap();
    let start = vault.start_unlock(ORIGIN, &phone.id).unwrap();
    let (id, t, nonce, sealed) = phone.answer(&identity, &start);
    assert_eq!(vault.finish_unlock(&laptop.id, &id, &t, &nonce, &sealed, &[]), Err("invalid_exchange".into()), "another device's session");
    // The failed attempt spent it.
    assert_eq!(vault.finish_unlock(&phone.id, &id, &t, &nonce, &sealed, &[]), Err("invalid_exchange".into()));
    let start = vault.start_unlock(ORIGIN, &phone.id).unwrap();
    let (id, t, nonce, mut sealed) = phone.answer(&identity, &start);
    sealed.replace_range(0..2, "AA");
    assert!(vault.finish_unlock(&phone.id, &id, &t, &nonce, &sealed, &[]).is_err(), "tampered");
    assert!(vault.key().is_none());
    release(&vault, &laptop).unwrap();
    assert!(vault.key().is_some());
}

#[test]
fn devices_enrolled_later_get_wraps_and_revoked_ones_lose_theirs() {
    let dir = tempfile::tempdir().unwrap();
    let hold = Arc::new(MemoryHold::default());
    let phone = Device::new("dev_phone_000001");
    let tablet = Device::new("dev_tablet_00001");
    let vault = vault_in(dir.path(), hold.clone());
    vault.set_up(&[phone.key()]).unwrap();
    assert_eq!(vault.wrap_missing(&[phone.key(), tablet.key()]), 1);
    assert_eq!(vault.status().wrapped_devices, 2);
    vault.revoke(&phone.id);
    hold.clear().unwrap();
    assert_eq!(vault.start_unlock(ORIGIN, &phone.id).unwrap(), UnlockStart::NoWrap);
    assert_eq!(vault.wrap_missing(&[phone.key()]), 0, "nothing is wrapped while locked");
    release(&vault, &tablet).unwrap();
    // Released with the enrolled devices' list (here: the tablet's only, as
    // the daemon's list no longer has a revoked device): nothing new to wrap.
    assert_eq!(vault.status().wrapped_devices, 1);
    assert_eq!(vault.wrap_missing(&[phone.key()]), 1, "a device enrolled again is wrapped while unlocked");
    vault.forget_devices();
    assert_eq!(vault.status(), VaultStatus { set_up: true, unlocked: true, wrapped_devices: 0 });
}

#[test]
fn enrolment_needs_the_devices_pairing_key() {
    use p256::ecdsa::signature::Signer;
    let signing = SigningKey::random(&mut rand::rngs::OsRng);
    let spki = b64(VerifyingKey::from(&signing).to_public_key_der().unwrap().as_bytes());
    let device = Device::new("dev_phone_000001");
    let ecdh = device.key().ecdh;
    let signature: Signature = signing.sign(enrol_payload(ORIGIN, &device.id, &ecdh).as_bytes());
    let sig = b64(&signature.to_bytes());
    Vault::check_enrolment(ORIGIN, &device.id, &spki, &ecdh, &sig).unwrap();
    assert!(Vault::check_enrolment(ORIGIN, "dev_other_000001", &spki, &ecdh, &sig).is_err(), "bound to the device id");
    let other = Device::new("dev_phone_000001").key().ecdh;
    assert!(Vault::check_enrolment(ORIGIN, &device.id, &spki, &other, &sig).is_err(), "bound to the key");
    assert_eq!(Vault::check_enrolment(ORIGIN, &device.id, &spki, "bm90IGEga2V5", &sig), Err("invalid_ecdh_key".into()));
}

/// The vector `src/__tests__/server/secretsRelease.test.ts` checks WebCrypto
/// against: both sides derive the transport key with one function.
#[test]
fn hkdf_matches_the_browsers_vector() {
    let key = hkdf32(&[1u8; 130], &[2u8; 32], "slug-secrets-v1:transportid");
    let hex: String = key.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(hex, HKDF_VECTOR);
}

/// `HKDF-SHA256(salt = 0x01 × 130, ikm = 0x02 × 32, info = "slug-secrets-v1:transportid")`.
const HKDF_VECTOR: &str = "5a006dd92eb477578317865f80184da915d4069bd41cd41c564de0ff7e4d946c";

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.extend(walk(&path));
        } else {
            out.push(path);
        }
    }
    out
}

fn copy_tree(from: &Path, to: &Path) {
    for path in walk(from) {
        let target = to.join(path.strip_prefix(from).unwrap());
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::copy(&path, &target).unwrap();
    }
}

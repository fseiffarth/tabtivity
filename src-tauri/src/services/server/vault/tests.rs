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
    assert_eq!(vault.status(), VaultStatus { set_up: true, unlocked: true, wrapped_devices: 1, recovery_code: true });
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
    assert_eq!(thief.status(), VaultStatus { set_up: true, unlocked: false, wrapped_devices: 1, recovery_code: true });
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
    vault.revoke(&phone.id, &[tablet.key()]).unwrap();
    hold.clear().unwrap();
    assert_eq!(vault.start_unlock(ORIGIN, &phone.id).unwrap(), UnlockStart::NoWrap);
    assert_eq!(vault.wrap_missing(&[phone.key()]), 0, "nothing is wrapped while locked");
    release(&vault, &tablet).unwrap();
    // Released with the enrolled devices' list (here: the tablet's only, as
    // the daemon's list no longer has a revoked device): nothing new to wrap.
    assert_eq!(vault.status().wrapped_devices, 1);
    // A revoked id never comes back (pairing mints a new one): a list read
    // before the revoke still naming it wraps nothing for it.
    assert_eq!(vault.wrap_missing(&[phone.key()]), 0, "a revoked device is never wrapped again");
    let laptop = Device::new("dev_laptop_00001");
    assert_eq!(vault.wrap_missing(&[laptop.key()]), 1, "a device paired later is wrapped while unlocked");
    vault.forget_devices(&[]).unwrap();
    assert_eq!(vault.status(), VaultStatus { set_up: true, unlocked: true, wrapped_devices: 0, recovery_code: true });
}

// ── Rotation on revoke (user decision 2026-10-03) ──────────────────────────

/// A server's sealed things: a saved password and a device-mode mail store.
fn seal_things(vault: &Vault, dir: &Path) -> crate::services::mail_crypt::MailKeys {
    vault.set_credential("imap:alice@mail.example", Some("hunter2")).unwrap();
    let k = vault.key().unwrap();
    crate::services::mail_crypt::enable_with_device(&dir.join("mail"), &crate::services::mail_crypt::device_kek_from(&k)).unwrap()
}

/// Everything sealed opens with the vault's current K.
fn assert_opens(vault: &Vault, dir: &Path, mail: &crate::services::mail_crypt::MailKeys) {
    let k = vault.key().expect("unlocked");
    assert_eq!(vault.credential("imap:alice@mail.example").as_deref(), Some("hunter2"));
    let opened = crate::services::mail_crypt::unlock_with_device_key(&dir.join("mail"), &k).expect("mail opens with the current K");
    assert_eq!(opened.field.as_bytes(), mail.field.as_bytes(), "the mail store's own key is unchanged");
    let file = WrapFile::load(dir).unwrap();
    assert_eq!(file.check.as_deref(), Some(secrets::key_check(&k).as_str()));
    assert!(!file.rotate, "nothing pending");
    for leftover in ["secrets/rotation.json", "secrets/wraps.json.next", "secrets/credentials.json.next", "mail/key.json.next"] {
        assert!(!dir.join(leftover).exists(), "{leftover} left behind");
    }
}

/// What a revoked device does offline with an old copy of `wraps.json`: its
/// own wrap and ECDH secret give the K of that time.
fn offline_k(device: &Device, old_wraps: &WrapFile) -> MasterKey {
    let wrap = old_wraps.device(&device.id).expect("the old copy has its wrap");
    let x = PublicKey::from_sec1_bytes(&unb64(&wrap.ephemeral).unwrap()).unwrap();
    let shared = p256::ecdh::diffie_hellman(device.ecdh.to_nonzero_scalar(), x.as_affine());
    secrets::unwrap_with_shared(wrap, shared.raw_secret_bytes()).unwrap()
}

#[test]
fn revoking_rotates_k_and_a_revoked_device_with_old_wraps_opens_nothing_new() {
    let dir = tempfile::tempdir().unwrap();
    let hold = Arc::new(MemoryHold::default());
    let phone = Device::new("dev_phone_000001");
    let tablet = Device::new("dev_tablet_00001");
    let vault = vault_in(dir.path(), hold.clone());
    let code = vault.set_up(&[phone.key(), tablet.key()]).unwrap();
    let mail = seal_things(&vault, dir.path());
    let k1 = vault.key().unwrap();
    // The thief's copy, taken before the revoke.
    let old_wraps = WrapFile::load(dir.path()).unwrap();
    assert_eq!(offline_k(&phone, &old_wraps).bytes(), k1.bytes(), "the old copy did open the old K");

    vault.revoke(&phone.id, &[phone.key(), tablet.key()]).unwrap();
    let k2 = vault.key().expect("still unlocked");
    assert_ne!(k2.bytes(), k1.bytes(), "a new K");
    assert_eq!(vault.status(), VaultStatus { set_up: true, unlocked: true, wrapped_devices: 1, recovery_code: true });
    assert_opens(&vault, dir.path(), &mail);
    vault.set_credential("smtp:alice@mail.example", Some("n3w")).unwrap();

    // The old K opens none of the files as they are now.
    assert!(Vault::open_credentials_at(&dir.path().join("secrets/credentials.json"), &k1).is_err(), "credentials");
    assert!(crate::services::mail_crypt::unlock_with_device_key(&dir.path().join("mail"), &k1).is_err(), "the mail key file");
    let now = WrapFile::load(dir.path()).unwrap();
    assert!(now.device(&phone.id).is_none(), "the revoked device has no wrap");
    assert!(secrets::rewrap_recovery(now.recovery.as_ref().unwrap(), &k1, &MasterKey::generate()).is_err(), "the recovery wrap's A is not under the old K");
    let text = std::fs::read_to_string(WrapFile::path_in(dir.path())).unwrap();
    assert!(!text.contains(&b64(k1.bytes())) && !text.contains(&b64(k2.bytes())));

    // A reboot: the remaining device and the same recovery code open the new K.
    hold.clear().unwrap();
    assert_eq!(vault.start_unlock(ORIGIN, &phone.id).unwrap(), UnlockStart::NoWrap);
    release(&vault, &tablet).unwrap();
    assert_eq!(vault.key().unwrap().bytes(), k2.bytes());
    assert_eq!(vault.credential("smtp:alice@mail.example").as_deref(), Some("n3w"));
    hold.clear().unwrap();
    vault.recover(&code, &[tablet.key()]).unwrap();
    assert_eq!(vault.key().unwrap().bytes(), k2.bytes(), "the recovery code follows the rotation");
    assert_opens(&vault, dir.path(), &mail);
}

#[test]
fn a_revoke_while_locked_drops_the_wrap_at_once_and_rotates_at_the_next_release() {
    let dir = tempfile::tempdir().unwrap();
    let hold = Arc::new(MemoryHold::default());
    let phone = Device::new("dev_phone_000001");
    let tablet = Device::new("dev_tablet_00001");
    let vault = vault_in(dir.path(), hold.clone());
    vault.set_up(&[phone.key(), tablet.key()]).unwrap();
    let mail = seal_things(&vault, dir.path());
    let k1 = vault.key().unwrap();
    hold.clear().unwrap();

    vault.revoke(&phone.id, &[tablet.key()]).unwrap();
    let file = WrapFile::load(dir.path()).unwrap();
    assert!(file.rotate && file.device(&phone.id).is_none(), "pending, and the wrap is gone now");
    assert_eq!(vault.start_unlock(ORIGIN, &phone.id).unwrap(), UnlockStart::NoWrap, "it cannot unlock meanwhile");

    release(&vault, &tablet).unwrap();
    let k2 = vault.key().unwrap();
    assert_ne!(k2.bytes(), k1.bytes(), "rotated on release, before anything read with the old K");
    assert_opens(&vault, dir.path(), &mail);
}

/// A device revoked where no vault saw it (`--revoke-device` with the
/// daemon stopped) loses its wrap there, and the next release rotates; a
/// wrap of a device no longer enrolled is dropped on release too.
#[test]
fn an_offline_revoke_and_a_stale_wrap_rotate_at_the_next_release() {
    let dir = tempfile::tempdir().unwrap();
    let hold = Arc::new(MemoryHold::default());
    let phone = Device::new("dev_phone_000001");
    let tablet = Device::new("dev_tablet_00001");
    let laptop = Device::new("dev_laptop_00001");
    let vault = vault_in(dir.path(), hold.clone());
    vault.set_up(&[phone.key(), tablet.key(), laptop.key()]).unwrap();
    let mail = seal_things(&vault, dir.path());
    let k1 = vault.key().unwrap();
    hold.clear().unwrap();
    revoke_offline(dir.path(), &phone.id).unwrap();
    assert!(WrapFile::load(dir.path()).unwrap().rotate);
    // The laptop was dropped from the device list some other way: its wrap
    // is still there, but the release names only the tablet.
    release(&vault, &tablet).unwrap();
    assert_ne!(vault.key().unwrap().bytes(), k1.bytes());
    let file = WrapFile::load(dir.path()).unwrap();
    assert_eq!(file.devices.iter().map(|w| w.device_id.as_str()).collect::<Vec<_>>(), [tablet.id.as_str()]);
    assert_opens(&vault, dir.path(), &mail);

    // Unlocked at daemon start (the keyring kept K over a restart): a
    // pending rotation runs in `resume`.
    revoke_offline(dir.path(), &tablet.id).unwrap();
    let k2 = vault.key().unwrap();
    let restarted = vault_in(dir.path(), hold.clone());
    restarted.resume(&[]);
    assert_ne!(restarted.key().unwrap().bytes(), k2.bytes());
    assert_eq!(restarted.status().wrapped_devices, 0);
    assert_opens(&restarted, dir.path(), &mail);
}

/// The process dies at each step of a rotation; the next start settles it:
/// whatever K a remaining device (or the hold) gives back opens everything,
/// and the revoked device has no wrap.
#[test]
fn a_crash_at_any_step_of_a_rotation_loses_nothing() {
    use rotation::Step;
    for step in [Step::Journal, Step::Sealed, Step::Wraps, Step::Commit, Step::Moved, Step::Held] {
        let dir = tempfile::tempdir().unwrap();
        let hold = Arc::new(MemoryHold::default());
        let phone = Device::new("dev_phone_000001");
        let tablet = Device::new("dev_tablet_00001");
        let vault = vault_in(dir.path(), hold.clone());
        let code = vault.set_up(&[phone.key(), tablet.key()]).unwrap();
        let mail = seal_things(&vault, dir.path());
        let k1 = vault.key().unwrap();
        // The revoke's first half (its own commit), then the rotation dies.
        let mut file = WrapFile::load(dir.path()).unwrap();
        file.revoke(&phone.id);
        file.rotate = true;
        file.save(dir.path()).unwrap();
        assert_eq!(vault.rotate_inner(&k1, &[tablet.key()], Some(step)), Err(rotation::CRASHED.to_string()), "{step:?}");

        // The restart.
        let restarted = vault_in(dir.path(), hold.clone());
        let committed = !matches!(step, Step::Journal | Step::Sealed | Step::Wraps);
        match (step, restarted.key()) {
            (Step::Held, Some(k)) => assert_ne!(k.bytes(), k1.bytes(), "{step:?}: the new K is held"),
            (Step::Held, None) => panic!("{step:?}: the new K was held"),
            (_, Some(k)) => {
                assert!(!committed, "{step:?}: an old K must not stay held after the commit");
                assert_eq!(k.bytes(), k1.bytes());
            }
            (_, None) => assert!(committed, "{step:?}: before the commit the old K stays in force"),
        }
        if restarted.key().is_none() {
            release(&restarted, &tablet).unwrap();
        } else {
            restarted.resume(&[tablet.key()]);
        }
        assert_ne!(restarted.key().unwrap().bytes(), k1.bytes(), "{step:?}: rotated in the end");
        assert_opens(&restarted, dir.path(), &mail);
        assert_eq!(restarted.start_unlock(ORIGIN, &phone.id).unwrap(), UnlockStart::Unlocked);
        hold.clear().unwrap();
        assert_eq!(restarted.start_unlock(ORIGIN, &phone.id).unwrap(), UnlockStart::NoWrap, "{step:?}");
        restarted.recover(&code, &[tablet.key()]).unwrap();
        assert_opens(&restarted, dir.path(), &mail);
    }
}

#[test]
fn a_v1_recovery_wrap_is_upgraded_when_used_and_flagged_when_it_cannot_follow() {
    let dir = tempfile::tempdir().unwrap();
    let hold = Arc::new(MemoryHold::default());
    let phone = Device::new("dev_phone_000001");
    let vault = vault_in(dir.path(), hold.clone());
    vault.set_up(&[phone.key()]).unwrap();
    let k = vault.key().unwrap();
    let code = secrets::recovery_code();
    let mut file = WrapFile::load(dir.path()).unwrap();
    file.recovery = Some(secrets::wrap_with_recovery_v1(&k, &code));
    file.save(dir.path()).unwrap();
    assert_eq!(vault.repin_offer(ORIGIN), Err("recovery_outdated".into()));
    hold.clear().unwrap();
    vault.recover(&code, &[phone.key()]).unwrap();
    assert!(WrapFile::load(dir.path()).unwrap().recovery.unwrap().is_current(), "upgraded with the code at hand");
    vault.repin_offer(ORIGIN).unwrap();

    // A v1 wrap at rotation time cannot follow: no recovery code, said so.
    let mut file = WrapFile::load(dir.path()).unwrap();
    file.recovery = Some(secrets::wrap_with_recovery_v1(&k, &code));
    file.save(dir.path()).unwrap();
    vault.forget_devices(&[]).unwrap();
    assert_eq!(vault.status(), VaultStatus { set_up: true, unlocked: true, wrapped_devices: 0, recovery_code: false });
    // Set up still, with no recovery wrap: a second set-up would orphan K,
    // and a device wrapped later still gets a locked start, not "not set up".
    assert!(vault.set_up(&[]).is_err(), "no second K");
    let tablet = Device::new("dev_tablet_00001");
    assert_eq!(vault.wrap_missing(&[tablet.key()]), 1);
    hold.clear().unwrap();
    assert!(matches!(vault.start_unlock(ORIGIN, &tablet.id).unwrap(), UnlockStart::Locked { .. }));
    release(&vault, &tablet).unwrap();
    let fresh = vault.new_recovery_code().unwrap();
    hold.clear().unwrap();
    vault.recover(&fresh, &[]).unwrap();
    assert!(vault.status().recovery_code);
}

/// Races around a rotation (review 2026-10-03): a wrap read before the
/// commit opens the retired K, and a device list read before a revoke still
/// names the revoked device. Neither may put the retired K in the hold or
/// wrap K for the revoked device.
#[test]
fn a_retired_key_and_a_stale_device_list_change_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let hold = Arc::new(MemoryHold::default());
    let phone = Device::new("dev_phone_000001");
    let tablet = Device::new("dev_tablet_00001");
    let laptop = Device::new("dev_laptop_00001");
    let vault = vault_in(dir.path(), hold.clone());
    vault.set_up(&[phone.key(), tablet.key(), laptop.key()]).unwrap();
    let mail = seal_things(&vault, dir.path());
    let k1 = vault.key().unwrap();
    let stale = [phone.key(), tablet.key(), laptop.key()];
    let finish = |device: &Device, list: &[DeviceKey]| {
        let identity = vault.identity_public().unwrap();
        let start = vault.start_unlock(ORIGIN, &device.id).unwrap();
        let (id, t, nonce, sealed) = device.answer(&identity, &start);
        vault.finish_unlock(&device.id, &id, &t, &nonce, &sealed, list)
    };

    vault.revoke(&phone.id, &[tablet.key(), laptop.key()]).unwrap();
    let k2 = vault.key().unwrap();
    // The laptop's release read its wrap before the commit: it hands in K1.
    hold.clear().unwrap();
    assert!(vault.released(&k1, &stale).is_err(), "the retired K is refused");
    assert!(vault.key().is_none(), "and not held");
    // A release and an enrolment with the list read before the revoke.
    finish(&tablet, &stale).unwrap();
    assert_eq!(vault.key().unwrap().bytes(), k2.bytes());
    vault.released(&k2, &stale).unwrap();
    assert_eq!(vault.wrap_missing(&stale), 0);
    assert!(WrapFile::load(dir.path()).unwrap().device(&phone.id).is_none(), "no wrap for the revoked device");
    assert_opens(&vault, dir.path(), &mail);

    // Revoked while locked, then released with a stale list: the rotation
    // wraps the new K for the remaining devices only.
    hold.clear().unwrap();
    vault.revoke(&laptop.id, &[tablet.key()]).unwrap();
    let dev = |w: &WrapFile| w.devices.iter().map(|w| w.device_id.clone()).collect::<Vec<String>>();
    assert_eq!(dev(&WrapFile::load(dir.path()).unwrap()), vec![tablet.id.clone()]);
    finish(&tablet, &stale).unwrap();
    assert_ne!(vault.key().unwrap().bytes(), k2.bytes(), "rotated at the release");
    assert_eq!(dev(&WrapFile::load(dir.path()).unwrap()), vec![tablet.id.clone()], "the stale list wrapped nobody revoked");
    assert_opens(&vault, dir.path(), &mail);
}

// ── Re-pinning a lost identity key (user decision 2026-10-03) ──────────────

#[test]
fn a_lost_identity_key_is_re_pinned_only_with_the_recovery_code() {
    let dir = tempfile::tempdir().unwrap();
    let hold = Arc::new(MemoryHold::default());
    let phone = Device::new("dev_phone_000001");
    let vault = vault_in(dir.path(), hold.clone());
    let code = vault.set_up(&[phone.key()]).unwrap();
    let pinned = vault.identity_public().unwrap();
    // The identity key is lost (a partial restore); a new one is made.
    std::fs::remove_file(dir.path().join("secrets/identity.key")).unwrap();
    hold.clear().unwrap();
    let restarted = vault_in(dir.path(), hold.clone());
    let offer = restarted.repin_offer(ORIGIN).unwrap();
    assert_ne!(offer.identity, pinned);
    // The phone's exchange fails against the pinned key ...
    let start = restarted.start_unlock(ORIGIN, &phone.id).unwrap();
    let UnlockStart::Locked { payload, signature, .. } = &start else { panic!() };
    let old = VerifyingKey::from(PublicKey::from_public_key_der(&unb64(&pinned).unwrap()).unwrap());
    assert!(old.verify(payload.as_bytes(), &Signature::from_slice(&unb64(signature).unwrap()).unwrap()).is_err());
    // ... and the recovery code re-pins the new one, locked or not.
    let check = |code: &str, offer: &RepinOffer| {
        secrets::check_repin(code, &offer.salt, &offer.ephemeral, &offer.nonce, &offer.sealed, &offer.auth_nonce, ORIGIN, &offer.identity, &offer.binding)
    };
    assert!(check(&code, &offer));
    assert!(!check(&secrets::recovery_code(), &offer), "another code");
    let swapped = RepinOffer { identity: pinned.clone(), ..offer.clone() };
    assert!(!check(&code, &swapped), "the binding is for one identity");
    // With the new pin the phone releases K again.
    release(&restarted, &phone).unwrap();
    assert!(restarted.key().is_some());
    // Rotated K: the offer follows, the same code still re-pins.
    let tablet = Device::new("dev_tablet_00001");
    restarted.wrap_missing(&[phone.key(), tablet.key()]);
    restarted.revoke(&tablet.id, &[phone.key()]).unwrap();
    assert!(check(&code, &restarted.repin_offer(ORIGIN).unwrap()));
}

/// The vector `src/__tests__/mobile/MobileSecretsRelease.test.ts` checks
/// `checkRepin` against: made by `print_a_repin_vector`. Its derivations
/// name the brand slug (`secrets::context`), so a rename remakes it.
#[test]
fn the_repin_vector_checks() {
    let v = &REPIN_VECTOR;
    assert!(secrets::check_repin(v.code, v.salt, v.ephemeral, v.nonce, v.sealed, v.auth_nonce, ORIGIN, v.identity, v.binding));
    assert!(!secrets::check_repin(v.code, v.salt, v.ephemeral, v.nonce, v.sealed, v.auth_nonce, ORIGIN, "AAAA", v.binding));
}

struct Vector {
    code: &'static str,
    salt: &'static str,
    ephemeral: &'static str,
    nonce: &'static str,
    sealed: &'static str,
    auth_nonce: &'static str,
    identity: &'static str,
    binding: &'static str,
}

const REPIN_VECTOR: Vector = Vector {
    code: "8ef8-e89b-c049-e1a0-373c-4944-2858-41c0",
    salt: "Y1NhEUVqetU8Ee2LPjHvHw",
    ephemeral: "BKqQH8LgudJ_fBD56lEsYJdgMFzV0w_C0HtCFcHEHIA6KpWv59lA2SdS6U_GBtuwEgC_9YlyggmP1gtbMjktm50",
    nonce: "LWrwX_Jrtxdv4NkD",
    sealed: "gVCmwcvNbmSD-rvI_VQqyOZIC6BbL_WhTVLZJp4qviRmVYkOuyV8rMF-fZtnfj05",
    auth_nonce: "FjrRrJmXuzIBw9ud",
    identity: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEKkDURY8Syd9-UTEdLF0YhWAyoWJ34Iaf8hcJyIZne5Z8ERpICQjhw9039TemZ1DEY_mNAye8h1svmWfleHLNOw",
    binding: "hZ_YVpo4uqHK94P-YZpujj64pDLzzPw5jfLubTaCt_U",
};

/// Prints a fresh vector (run by hand with `--ignored --nocapture`).
#[test]
#[ignore]
fn print_a_repin_vector() {
    let dir = tempfile::tempdir().unwrap();
    let vault = vault_in(dir.path(), Arc::new(MemoryHold::default()));
    let code = vault.set_up(&[]).unwrap();
    let offer = vault.repin_offer(ORIGIN).unwrap();
    println!("{} {}", code.as_str(), serde_json::to_string(&offer).unwrap());
}

/// Two first uses of the identity key at once (two devices enrolling) get
/// one key: a device that pinned a key overwritten a moment later could
/// never verify an unlock exchange again.
#[test]
fn concurrent_first_uses_share_one_identity_key() {
    for _ in 0..20 {
        let dir = tempfile::tempdir().unwrap();
        let vault = Arc::new(vault_in(dir.path(), Arc::new(MemoryHold::default())));
        let barrier = Arc::new(std::sync::Barrier::new(4));
        let threads: Vec<_> = (0..4)
            .map(|_| {
                let (vault, barrier) = (vault.clone(), barrier.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    vault.identity_public().unwrap()
                })
            })
            .collect();
        let keys: Vec<String> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        assert!(keys.iter().all(|k| *k == keys[0]), "one identity: {keys:?}");
        assert_eq!(vault.identity_public().unwrap(), keys[0], "and it is the one on disk");
    }
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

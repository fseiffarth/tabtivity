//! Rotating K when a device is revoked (user decision 2026-10-03).
//!
//! A revoked device keeps its ECDH key, and someone may keep a copy of the
//! old `wraps.json`: together they open the old K offline. So a revoke mints
//! a new K and re-seals everything K sealed — the credential store, a
//! device-mode mail `key.json` (the mail store's own master key stays; only
//! its wrap changes), the recovery wrap (to the code's public key `R`, so the
//! code stays valid without being known here) and a wrap per remaining
//! device. Nothing in the new files opens with the old K.
//!
//! **Crash safety.** One commit point, the rename of `wraps.json.next` over
//! `wraps.json`:
//!
//! 1. `rotation.json` names the new key id and the files to re-seal;
//! 2. each re-sealed file is written beside its original (`<file>.next`);
//! 3. the new `wraps.json` is written as `wraps.json.next`;
//! 4. **commit**: renamed over `wraps.json`;
//! 5. each `<file>.next` is renamed over its original;
//! 6. the new K goes into the hold; `rotation.json` is removed.
//!
//! Before step 4 the old files and the old wraps are untouched, so a crash
//! leaves the old K in force; [`Vault::settle`] (every [`Vault::new`])
//! deletes the `.next` files. After step 4 the new wraps are in force and
//! every re-sealed file exists beside its original, so `settle` finishes
//! step 5. If the hold still has the old K then (a crash between 4 and 6),
//! `settle` sees its [`secrets::key_check`] differ and clears it: K is locked
//! until a device releases the new one — never data that no remaining key
//! opens. The old K is never written anywhere; it only leaves the hold.
//!
//! **Locked at revoke time:** the wrap is deleted at once (so that device
//! cannot unlock meanwhile) and `wraps.json` records `rotate`; the next
//! release — a remaining device or the recovery code — rotates before
//! anything else sees K.

use super::*;

const JOURNAL: &str = "rotation.json";

#[derive(Serialize, Deserialize)]
struct Journal {
    /// The new key's id: the commit happened iff `wraps.json` has it.
    kid: String,
    /// The re-sealed files, relative to the state dir.
    files: Vec<String>,
}

/// Where a rotation can stop when the process dies (the tests' crash points).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Step {
    Journal,
    Sealed,
    Wraps,
    Commit,
    Moved,
    Held,
}

/// What a simulated crash returns: nothing after it runs, nothing is undone.
pub(super) const CRASHED: &str = "crashed";

pub(super) fn new_kid() -> String {
    b64(&random::<12>())
}

fn next_of(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".next");
    PathBuf::from(name)
}

fn sync_dir(path: &Path) {
    if let Some(dir) = path.parent() {
        if let Ok(dir) = std::fs::File::open(dir) {
            let _ = dir.sync_all();
        }
    }
}

/// Rename `<path>.next` over `path` if it is there.
fn move_in(path: &Path) -> Result<(), String> {
    let next = next_of(path);
    match std::fs::rename(&next, path) {
        Ok(()) => {
            sync_dir(path);
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("{}: {e}", next.display())),
    }
}

fn remove(path: &Path) {
    let _ = std::fs::remove_file(path);
}

fn crash_at(crash: Option<Step>, step: Step) -> Result<(), String> {
    if crash == Some(step) {
        return Err(CRASHED.into());
    }
    Ok(())
}

/// A revoke with no vault in the process (`--revoke-device` while the daemon
/// is stopped): the wrap goes and the rotation waits for the next release.
pub fn revoke_offline(state_dir: &Path, device_id: &str) -> Result<(), String> {
    let mut file = WrapFile::load(state_dir)?;
    if file.revoke(device_id) {
        file.rotate = true;
        file.save(state_dir)?;
    }
    Ok(())
}

impl Vault {
    fn journal_path(&self) -> PathBuf {
        self.dir().join(JOURNAL)
    }

    /// The device-mode mail store's key file (the one mail store a daemon
    /// has: `<state>/mail`, as `commands::mail::mail_dir`).
    fn mail_key_file(&self) -> PathBuf {
        crate::services::mail_crypt::key_file_path(&self.state_dir.join("mail"))
    }

    /// Every file a rotation may re-seal; a journal naming anything else is
    /// not followed.
    fn known_targets(&self) -> [PathBuf; 2] {
        [self.credentials_path(), self.mail_key_file()]
    }

    /// The files sealed under K right now.
    fn sealed_targets(&self) -> Result<Vec<PathBuf>, String> {
        let mut out = Vec::new();
        let credentials = self.credentials_path();
        if credentials.exists() {
            out.push(credentials);
        }
        let mail = self.state_dir.join("mail");
        if crate::services::mail_crypt::read_key_file(&mail)?.is_some_and(|f| f.mode == crate::services::mail_crypt::UnlockMode::Device) {
            out.push(self.mail_key_file());
        }
        Ok(out)
    }

    /// `target`'s content re-sealed from `old` to `new`.
    fn reseal(&self, target: &Path, old: &MasterKey, new: &MasterKey) -> Result<Zeroizing<Vec<u8>>, String> {
        if target == self.credentials_path() {
            let map = Self::open_credentials_at(target, old)?;
            let sealed = Self::seal_credentials(new, map)?;
            return serde_json::to_vec(&sealed).map(Zeroizing::new).map_err(|e| e.to_string());
        }
        let dir = target.parent().ok_or("no mail dir")?;
        crate::services::mail_crypt::rewrap_device_key_file(dir, old, new).map(Zeroizing::new)
    }

    /// Finish or undo a rotation a crash interrupted, then make sure the
    /// hold does not keep a K the wraps no longer name. Caller holds `files`.
    pub(super) fn settle(&self) {
        let Ok(file) = WrapFile::load(&self.state_dir) else { return };
        let journal_path = self.journal_path();
        if let Ok(bytes) = std::fs::read(&journal_path) {
            // Written atomically, so unreadable means not ours to guess at:
            // touching nothing keeps both sets of files.
            let Ok(journal) = serde_json::from_slice::<Journal>(&bytes) else {
                eprintln!("secrets: {} is unreadable; left as it is", journal_path.display());
                return;
            };
            let known = self.known_targets();
            let targets: Vec<PathBuf> = journal.files.iter().map(|f| self.state_dir.join(f)).filter(|p| known.contains(p)).collect();
            let mut done = true;
            if file.kid.as_deref() == Some(journal.kid.as_str()) {
                for target in &targets {
                    if let Err(error) = move_in(target) {
                        eprintln!("secrets: finishing an interrupted rotation: {error}");
                        done = false;
                    }
                }
                eprintln!("secrets: finished a rotation a restart interrupted");
            } else {
                for target in &targets {
                    remove(&next_of(target));
                }
                eprintln!("secrets: undid a rotation a restart interrupted before it took effect");
            }
            if done {
                remove(&journal_path);
            }
        }
        remove(&next_of(&WrapFile::path_in(&self.state_dir)));
        if let (Some(check), Some(held)) = (&file.check, self.key()) {
            if secrets::key_check(&held) != *check {
                eprintln!("secrets: the held key is not the current one; locked until a device releases it");
                let _ = self.hold.clear();
            }
        }
    }

    /// Delete the wraps `drop` picks, record the pending rotation, and
    /// rotate now if K is held.
    pub(super) fn revoke_where(&self, drop: impl Fn(&secrets::DeviceWrap) -> bool, remaining: &[DeviceKey]) -> Result<(), String> {
        let _guard = self.files();
        let mut file = WrapFile::load(&self.state_dir)?;
        let before = file.devices.len();
        file.devices.retain(|w| !drop(w));
        if file.devices.len() == before && !file.rotate {
            return Ok(());
        }
        if !file.is_set_up() {
            return file.save(&self.state_dir);
        }
        file.rotate = true;
        // The revoke itself: from here the device's wrap is gone, whatever
        // happens to the rotation.
        file.save(&self.state_dir)?;
        match self.key() {
            Some(old) => self.rotate(&old, &self.live(remaining)),
            None => Ok(()),
        }
    }

    /// After a release: drop wraps of devices that are no longer enrolled
    /// and run a pending rotation.
    pub(super) fn catch_up(&self, devices: &[DeviceKey]) {
        if let Err(error) = self.revoke_where(|w| self.is_revoked(&w.device_id) || !devices.iter().any(|d| d.id == w.device_id), devices) {
            eprintln!("secrets: rotating the key after a revoke failed (retried at the next release): {error}");
        }
    }

    /// At daemon start (`serverd`'s `install_vault`): K survived a restart in
    /// the keyring, so a rotation a crash or an offline revoke left pending
    /// runs now rather than at the next reboot's release.
    pub fn resume(&self, devices: &[DeviceKey]) {
        if self.key().is_some() {
            self.catch_up(devices);
        }
    }

    /// Rotate from `old` (held) to a new K. Caller holds `files`. A failure
    /// is settled (undone before the commit, finished after it) and the
    /// pending flag stays, so the next release retries.
    fn rotate(&self, old: &MasterKey, devices: &[DeviceKey]) -> Result<(), String> {
        let result = self.rotate_inner(old, devices, None);
        if result.is_err() {
            self.settle();
        }
        result
    }

    pub(super) fn rotate_inner(&self, old: &MasterKey, devices: &[DeviceKey], crash: Option<Step>) -> Result<(), String> {
        let file = WrapFile::load(&self.state_dir)?;
        let new = MasterKey::generate();
        let kid = new_kid();
        let targets = self.sealed_targets()?;
        let files = targets.iter().filter_map(|t| t.strip_prefix(&self.state_dir).ok()).map(|t| t.to_string_lossy().into_owned()).collect();
        crate::services::mobile_control::store::ensure_private_dir(&self.dir())?;
        crate::services::mobile_control::store::write_json_atomic(&self.journal_path(), &Journal { kid: kid.clone(), files }, 0o600)?;
        crash_at(crash, Step::Journal)?;

        for target in &targets {
            let bytes = self.reseal(target, old, &new)?;
            crate::services::mobile_control::store::write_bytes_atomic(&next_of(target), &bytes, 0o600)?;
        }
        crash_at(crash, Step::Sealed)?;

        let recovery = match &file.recovery {
            Some(wrap) if wrap.is_current() => Some(secrets::rewrap_recovery(wrap, old, &new)?),
            // A v1 wrap cannot follow without the code: the status says
            // so and the panel offers a new code.
            _ => None,
        };
        let mut next = WrapFile { devices: Vec::new(), recovery, kid: Some(kid), check: Some(secrets::key_check(&new)), rotate: false };
        for device in devices {
            if let Ok(public) = secrets::device_key(&device.ecdh) {
                next.put(secrets::wrap_for_device(&new, &device.id, &public));
            }
        }
        let wraps = WrapFile::path_in(&self.state_dir);
        next.save_to(&next_of(&wraps))?;
        crash_at(crash, Step::Wraps)?;

        move_in(&wraps)?;
        crash_at(crash, Step::Commit)?;

        for target in &targets {
            move_in(target)?;
        }
        crash_at(crash, Step::Moved)?;

        let held = self.hold.put(&new);
        crash_at(crash, Step::Held)?;
        remove(&self.journal_path());
        if held.is_err() {
            // The old K would open nothing now: locked, not wrong.
            let _ = self.hold.clear();
        }
        eprintln!("secrets: rotated the key ({} device wraps)", next.devices.len());
        held
    }
}

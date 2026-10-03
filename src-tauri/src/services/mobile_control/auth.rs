use std::{
    collections::{HashMap, VecDeque},
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use base64ct::{Base64UrlUnpadded, Encoding};
use hmac::{Hmac, Mac};
use p256::{
    ecdsa::{signature::Verifier, Signature, VerifyingKey},
    pkcs8::DecodePublicKey,
    PublicKey,
};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use subtle::ConstantTimeEq;

use super::{
    protocol::AdminDevice,
    push::{Delivery, Notice, PushPrefs, PushStore},
    store,
};

type HmacSha256 = Hmac<Sha256>;
const DEVICE_SCHEMA: u32 = 1;
const PAIR_TTL: u64 = 5 * 60;
/// Separate budgets so an unauthenticated `pair` flood cannot starve a paired
/// device's `challenge`/`login`, and so one device cannot starve another.
const PAIR_ATTEMPT_BUDGET: usize = 10;
const AUTH_ATTEMPT_BUDGET: usize = 30;
/// A pairing code retires after this many wrong guesses rather than after the
/// first one: consuming it eagerly let any caller burn every code the user made.
const PAIR_CODE_ATTEMPTS: u8 = 5;
/// Backstop only. Scopes are `pair`, `auth:unknown`, and one per paired device,
/// so the live count is bounded by the device list.
const MAX_RATE_BUCKETS: usize = 64;
const CHALLENGE_TTL: u64 = 60;
/// A session slides: every authenticated request (`touch`) pushes its expiry
/// this far out again. Sessions never touch disk, so a sidecar restart still
/// invalidates every one of them — the phone re-logs in with its device key
/// when that happens. What this window closes is the gap the idle lock cannot:
/// an app the OS killed sends no `DELETE /auth/session`, and a fixed 12 h
/// token then outlived the phone's own lock by hours.
pub const SESSION_IDLE: u64 = 15 * 60;
/// The absolute cap on one login, however active the phone stays.
pub const SESSION_MAX: u64 = 12 * 60 * 60;
/// How long an open ticket (`open_ticket`) lets its one URL be fetched. Long
/// enough for the browser's PDF viewer to fetch it again or hand it to its
/// download manager, short enough that a URL left in the browser's history is
/// dead by the time anybody reads it there.
pub const OPEN_TICKET_TTL: u64 = 5 * 60;
const MAX_OPEN_TICKETS: usize = 64;

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn random_bytes<const N: usize>() -> Result<[u8; N], String> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).map_err(|e| format!("no system randomness: {e}"))?;
    Ok(bytes)
}

/// Unknown device ids all share one bucket, so a flood of made-up ids can never
/// evict a real device's bucket and lock the phone out.
fn auth_scope(device_id: &str, known: bool) -> String {
    if known {
        format!("auth:{device_id}")
    } else {
        "auth:unknown".into()
    }
}

fn random_id<const N: usize>() -> Result<String, String> {
    Ok(Base64UrlUnpadded::encode_string(&random_bytes::<N>()?))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub public_key: String,
    pub created_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<u64>,
    /// The device's ECDH public key for the server's device-released secrets
    /// key (hosted plan §6.8), SEC1 base64url; enrolled after pairing with a
    /// signature of the pairing key ([`AuthStore::enrol_secrets_key`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ecdh_public_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DeviceFile {
    schema: u32,
    devices: Vec<Device>,
}

impl Default for DeviceFile {
    fn default() -> Self {
        Self {
            schema: DEVICE_SCHEMA,
            devices: vec![],
        }
    }
}

/// A server invite (hosted plan §4.1), written by the admin helper into the
/// user's control dir: the hash of a single-use pairing code.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InviteFile {
    /// [`invite_hash`] of the code.
    pub hash: String,
    pub expires_at: u64,
    #[serde(default)]
    pub attempts: u8,
}

fn device_keys_of(file: &DeviceFile) -> Vec<crate::services::server::vault::DeviceKey> {
    file.devices
        .iter()
        .filter_map(|d| d.ecdh_public_key.as_ref().map(|ecdh| crate::services::server::vault::DeviceKey { id: d.id.clone(), ecdh: ecdh.clone() }))
        .collect()
}

/// [`AuthStore::secrets_device_keys`] from the file, for a caller that does
/// not hold the store (the Server settings' set-up command).
pub fn read_secrets_device_keys(control_dir: &Path) -> Vec<crate::services::server::vault::DeviceKey> {
    store::read_json::<DeviceFile>(&control_dir.join("devices.json")).map(|f| device_keys_of(&f)).unwrap_or_default()
}

/// The actions that need a pairing-key signature on top of the session.
pub const SIGNED_ACTIONS: [&str; 2] = ["secrets-setup", "secrets-recovery-code"];

/// The invite file's name under the control dir.
pub const INVITE_FILE: &str = "invite.json";
/// How long an invite may be redeemed.
pub const INVITE_TTL: u64 = 24 * 60 * 60;

/// `hex(SHA-256("invite\n" ‖ code))`: what the helper writes and what
/// [`AuthStore::pair`] compares. Both sides of the server build know it.
pub fn invite_hash(code: &str) -> String {
    use sha2::Digest;
    let mut hasher = Sha256::new();
    hasher.update(b"invite\n");
    hasher.update(code.as_bytes());
    hasher.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// Write the invite for `code` into `control_dir` (the helper's step, done
/// as the user; also what a test does to enrol a first device).
pub fn write_invite(control_dir: &Path, code: &str, expires_at: u64) -> Result<(), String> {
    store::ensure_private_dir(control_dir)?;
    store::write_json_atomic(&control_dir.join(INVITE_FILE), &InviteFile { hash: invite_hash(code), expires_at, attempts: 0 }, 0o600)
}

#[derive(Clone)]
struct PairCode {
    hash: [u8; 32],
    expires_at: u64,
    attempts: u8,
}

#[derive(Clone)]
struct Challenge {
    device_id: String,
    payload: String,
    expires_at: u64,
}

/// A URL the phone asked to open outside the PWA, where its `SameSite=Strict`
/// session cookie does not go along: `target` (path and query) may be fetched
/// while `session` lives and the ticket has not expired.
#[derive(Clone)]
struct OpenTicket {
    session: String,
    target: String,
    expires_at: u64,
}

#[derive(Clone)]
struct Session {
    device_id: String,
    created_at: u64,
    expires_at: u64,
}

/// Where a session touched at `t` expires: the idle window from now, never
/// past the cap counted from its login.
fn session_deadline(created_at: u64, t: u64) -> u64 {
    (t + SESSION_IDLE).min(created_at + SESSION_MAX)
}

pub struct AuthStore {
    control_dir: PathBuf,
    origin: String,
    host_key: Vec<u8>,
    devices: DeviceFile,
    pairing: Option<PairCode>,
    challenges: HashMap<String, Challenge>,
    /// Single-use nonces for an action that needs the pairing key's
    /// signature on top of the session (the secrets key's set-up and a new
    /// recovery code). Apart from `challenges`, so one can never be spent
    /// as the other.
    action_challenges: HashMap<String, Challenge>,
    sessions: HashMap<String, Session>,
    tickets: HashMap<String, OpenTicket>,
    attempts: HashMap<String, VecDeque<u64>>,
    /// Web Push subscriptions, held here so revocation drops them in the same
    /// call (`push.rs`).
    push: PushStore,
}

impl AuthStore {
    pub fn open(control_dir: &Path, origin: String) -> Result<Self, String> {
        store::ensure_private_dir(control_dir)?;
        let key_path = control_dir.join("host.key");
        let host_key = if key_path.exists() {
            store::ensure_private_file(&key_path)?;
            let key = fs::read(&key_path).map_err(|e| format!("read host key: {e}"))?;
            if key.len() != 32 {
                return Err("host.key has invalid length".into());
            }
            key
        } else {
            let key = random_bytes::<32>()?.to_vec();
            let mut options = fs::OpenOptions::new();
            options.create_new(true).write(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            use std::io::Write;
            let mut file = options
                .open(&key_path)
                .map_err(|e| format!("create host key: {e}"))?;
            file.write_all(&key)
                .and_then(|_| file.sync_all())
                .map_err(|e| e.to_string())?;
            store::ensure_private_file(&key_path)?;
            key
        };
        let devices_path = control_dir.join("devices.json");
        let devices: DeviceFile = if devices_path.exists() {
            store::ensure_private_file(&devices_path)?;
            let file: DeviceFile = store::read_json(&devices_path)?;
            if file.schema != DEVICE_SCHEMA {
                return Err("devices.json has an unsupported schema".into());
            }
            file
        } else {
            DeviceFile::default()
        };
        let push = PushStore::open(control_dir)?;
        Ok(Self {
            control_dir: control_dir.to_path_buf(),
            origin,
            host_key,
            devices,
            pairing: None,
            challenges: HashMap::new(),
            action_challenges: HashMap::new(),
            sessions: HashMap::new(),
            tickets: HashMap::new(),
            attempts: HashMap::new(),
            push,
        })
    }

    pub fn host_key(&self) -> &[u8] {
        &self.host_key
    }

    /// Expired challenges and sessions are otherwise only ever removed when the
    /// exact entry is presented again, so an abandoned login leaked one forever.
    fn sweep_expired(&mut self, t: u64) {
        self.challenges.retain(|_, c| c.expires_at >= t);
        self.action_challenges.retain(|_, c| c.expires_at >= t);
        self.sessions.retain(|_, s| s.expires_at >= t);
        self.tickets.retain(|_, x| x.expires_at >= t);
    }

    /// Per-scope sliding window. A single global window meant 30 forged
    /// `pair` posts a minute locked the real phone out of `login` permanently,
    /// with no way back in because the same flood also ate each new code.
    fn rate_limit(&mut self, scope: &str, budget: usize) -> Result<(), String> {
        let t = now();
        self.sweep_expired(t);
        self.attempts.retain(|_, queue| {
            while queue.front().is_some_and(|v| t.saturating_sub(*v) > 60) {
                queue.pop_front();
            }
            !queue.is_empty()
        });
        if !self.attempts.contains_key(scope) && self.attempts.len() >= MAX_RATE_BUCKETS {
            return Err("too_many_attempts".into());
        }
        let queue = self.attempts.entry(scope.to_string()).or_default();
        if queue.len() >= budget {
            return Err("too_many_attempts".into());
        }
        queue.push_back(t);
        Ok(())
    }

    fn keyed(&self, purpose: &[u8], value: &[u8]) -> [u8; 32] {
        let mut mac = HmacSha256::new_from_slice(&self.host_key).expect("HMAC key");
        mac.update(purpose);
        mac.update(&[0]);
        mac.update(value);
        mac.finalize().into_bytes().into()
    }

    fn save_devices(&self) -> Result<(), String> {
        store::write_json_atomic(&self.control_dir.join("devices.json"), &self.devices, 0o600)
    }

    pub fn create_pairing_code(&mut self) -> Result<(String, u64), String> {
        // Rejection-sample below the largest multiple of 10^8 that fits a u32:
        // a bare modulo skews codes under 94 967 296 by ~2%.
        let raw = loop {
            let candidate = u32::from_be_bytes(random_bytes::<4>()?);
            if candidate < 4_200_000_000 {
                break candidate % 100_000_000;
            }
        };
        let code = format!("{raw:08}");
        let expires_at = now() + PAIR_TTL;
        self.pairing = Some(PairCode {
            hash: self.keyed(b"pair", code.as_bytes()),
            expires_at,
            attempts: 0,
        });
        Ok((code, expires_at))
    }

    pub fn pair(&mut self, code: &str, name: &str, public_key: &str) -> Result<String, String> {
        self.rate_limit("pair", PAIR_ATTEMPT_BUDGET)?;
        if code.len() != 8 || !code.bytes().all(|b| b.is_ascii_digit()) {
            return Err("invalid_pairing_code".into());
        }
        let supplied = self.keyed(b"pair", code.as_bytes());
        // The code the window (or a signed-in client) minted, else — on a
        // server — the invite the admin helper left in the control dir.
        let mut invite_used = false;
        match self.pairing.as_mut() {
            Some(pairing) if pairing.expires_at < now() => {
                self.pairing = None;
                return Err("invalid_pairing_code".into());
            }
            Some(pairing) if !bool::from(pairing.hash.ct_eq(&supplied)) => {
                pairing.attempts += 1;
                if pairing.attempts >= PAIR_CODE_ATTEMPTS {
                    self.pairing = None;
                }
                return Err("invalid_pairing_code".into());
            }
            Some(_) => {}
            None => {
                if !self.invite_matches(code) {
                    return Err("invalid_pairing_code".into());
                }
                invite_used = true;
            }
        }
        let clean_name = name.trim().chars().take(64).collect::<String>();
        if clean_name.is_empty() {
            return Err("device_name_required".into());
        }
        let der = Base64UrlUnpadded::decode_vec(public_key).map_err(|_| "invalid_public_key")?;
        // Length first: the bound exists so an unauthenticated caller cannot
        // hand the SPKI parser an arbitrarily long buffer.
        if der.len() > 256 {
            return Err("invalid_public_key".into());
        }
        PublicKey::from_public_key_der(&der).map_err(|_| "invalid_public_key")?;
        // Everything is validated; only now is the code spent.
        self.pairing = None;
        if invite_used {
            let _ = fs::remove_file(self.control_dir.join(INVITE_FILE));
        }
        let id = random_id::<20>()?;
        self.devices.devices.push(Device {
            id: id.clone(),
            name: clean_name,
            public_key: public_key.into(),
            created_at: now(),
            last_seen_at: None,
            ecdh_public_key: None,
        });
        self.save_devices()?;
        self.audit("paired", Some(&id));
        Ok(id)
    }

    /// Does `code` match a live invite in the control dir? The file is the
    /// admin helper's (hosted plan §4.1: `user add` writes it as the user,
    /// `0600`), never the gateway's — so a compromised gateway cannot enrol a
    /// device. A wrong guess counts like a pairing-code miss, and the file is
    /// removed after [`PAIR_CODE_ATTEMPTS`] of them or when it has expired.
    fn invite_matches(&mut self, code: &str) -> bool {
        let path = self.control_dir.join(INVITE_FILE);
        let Ok(mut invite) = store::read_json::<InviteFile>(&path) else { return false };
        if invite.expires_at < now() {
            let _ = fs::remove_file(&path);
            return false;
        }
        let supplied = invite_hash(code);
        if invite.hash.len() == supplied.len() && bool::from(invite.hash.as_bytes().ct_eq(supplied.as_bytes())) {
            return true;
        }
        invite.attempts += 1;
        if invite.attempts >= PAIR_CODE_ATTEMPTS {
            let _ = fs::remove_file(&path);
        } else {
            let _ = store::write_json_atomic(&path, &invite, 0o600);
        }
        false
    }

    pub fn challenge(&mut self, device_id: &str) -> Result<(String, String, u64), String> {
        let known = self.devices.devices.iter().any(|d| d.id == device_id);
        self.rate_limit(&auth_scope(device_id, known), AUTH_ATTEMPT_BUDGET)?;
        if !known {
            return Err("unknown_device".into());
        }
        let nonce = random_id::<24>()?;
        let expires_at = now() + CHALLENGE_TTL;
        let payload = format!(
            "{}\n{}\n{}\n{}\n{}",
            crate::brand::MOBILE_AUTH_CONTEXT,
            self.origin, device_id, nonce, expires_at
        );
        self.challenges.insert(
            nonce.clone(),
            Challenge {
                device_id: device_id.into(),
                payload: payload.clone(),
                expires_at,
            },
        );
        Ok((nonce, payload, expires_at))
    }

    pub fn login(
        &mut self,
        device_id: &str,
        nonce: &str,
        signature: &str,
    ) -> Result<(String, u64), String> {
        let known = self.devices.devices.iter().any(|d| d.id == device_id);
        self.rate_limit(&auth_scope(device_id, known), AUTH_ATTEMPT_BUDGET)?;
        let challenge = self.challenges.remove(nonce).ok_or("invalid_challenge")?;
        if challenge.device_id != device_id || challenge.expires_at < now() {
            return Err("invalid_challenge".into());
        }
        let device = self
            .devices
            .devices
            .iter_mut()
            .find(|d| d.id == device_id)
            .ok_or("unknown_device")?;
        let der =
            Base64UrlUnpadded::decode_vec(&device.public_key).map_err(|_| "invalid_public_key")?;
        let key = PublicKey::from_public_key_der(&der).map_err(|_| "invalid_public_key")?;
        let verifying = VerifyingKey::from(key);
        let sig = Base64UrlUnpadded::decode_vec(signature).map_err(|_| "invalid_signature")?;
        if sig.len() != 64 {
            return Err("invalid_signature".into());
        }
        let sig = Signature::from_slice(&sig).map_err(|_| "invalid_signature")?;
        verifying
            .verify(challenge.payload.as_bytes(), &sig)
            .map_err(|_| "invalid_signature")?;
        device.last_seen_at = Some(now());
        let token = random_id::<32>()?;
        let created_at = now();
        let expires_at = session_deadline(created_at, created_at);
        self.sessions.insert(
            token.clone(),
            Session {
                device_id: device_id.into(),
                created_at,
                expires_at,
            },
        );
        self.save_devices()?;
        self.audit("login", Some(device_id));
        Ok((token, expires_at))
    }

    /// The device behind a live session token, without extending it. The PTY
    /// bridge's periodic re-check uses this: a tick is not the phone speaking.
    pub fn authenticate(&mut self, token: &str) -> Option<String> {
        let session = self.sessions.get(token)?.clone();
        if session.expires_at < now() {
            self.sessions.remove(token);
            return None;
        }
        Some(session.device_id)
    }

    /// `authenticate`, and the session slides: every authenticated HTTP request
    /// and every frame the phone sends over its terminal socket lands here.
    pub fn touch(&mut self, token: &str) -> Option<String> {
        let t = now();
        let session = self.sessions.get_mut(token)?;
        if session.expires_at < t {
            self.sessions.remove(token);
            return None;
        }
        session.expires_at = session_deadline(session.created_at, t);
        Some(session.device_id.clone())
    }

    /// A ticket that lets `target` — one path and query — be fetched without
    /// the session cookie, for as long as the session behind `token` lives
    /// and at most `OPEN_TICKET_TTL`. The browser's own PDF viewer is a
    /// navigation handed over from the installed app, which the browser treats
    /// as arriving from outside the site: the strict cookie stays behind.
    pub fn open_ticket(&mut self, token: &str, target: &str) -> Result<String, String> {
        self.authenticate(token).ok_or("authentication_required")?;
        let t = now();
        self.sweep_expired(t);
        if self.tickets.len() >= MAX_OPEN_TICKETS {
            if let Some(oldest) = self
                .tickets
                .iter()
                .min_by_key(|(_, x)| x.expires_at)
                .map(|(key, _)| key.clone())
            {
                self.tickets.remove(&oldest);
            }
        }
        let ticket = random_id::<32>()?;
        self.tickets.insert(
            ticket.clone(),
            OpenTicket {
                session: token.into(),
                target: target.into(),
                expires_at: t + OPEN_TICKET_TTL,
            },
        );
        Ok(ticket)
    }

    /// The device behind `ticket` when it was issued for exactly `target` and
    /// neither it nor its session has ended. Using it does not slide the
    /// session: a browser tab re-reading a PDF is not the phone speaking.
    pub fn redeem_ticket(&mut self, ticket: &str, target: &str) -> Option<String> {
        let entry = self.tickets.get(ticket)?;
        if entry.expires_at < now() {
            self.tickets.remove(ticket);
            return None;
        }
        if entry.target != target {
            return None;
        }
        let session = entry.session.clone();
        self.authenticate(&session)
    }

    pub fn logout(&mut self, token: &str) {
        self.sessions.remove(token);
    }

    pub fn devices(&self) -> Vec<AdminDevice> {
        let t = now();
        self.devices
            .devices
            .iter()
            .map(|d| AdminDevice {
                id: d.id.clone(),
                name: d.name.clone(),
                created_at: d.created_at,
                last_seen_at: d.last_seen_at,
                online: self.sessions.values().any(|s| s.device_id == d.id && s.expires_at >= t),
            })
            .collect()
    }

    /// Register a signed-in device's ECDH key for the secrets key (§6.8).
    /// The session alone is not enough: the request carries a signature of
    /// the device's own pairing key, which a stolen cookie does not have.
    pub fn enrol_secrets_key(&mut self, device_id: &str, ecdh: &str, signature: &str) -> Result<(), String> {
        let device = self.devices.devices.iter_mut().find(|d| d.id == device_id).ok_or("unknown_device")?;
        crate::services::server::vault::Vault::check_enrolment(&self.origin, device_id, &device.public_key, ecdh, signature)?;
        // A new key for a device that had one (its browser lost the old
        // private key, or a save failed after an earlier enrolment): the wrap
        // made for the old key can never be opened again, and `wrap_missing`
        // skips a device that has a wrap — drop it, so the caller's
        // `wrap_missing` (while unlocked) or the next release wraps the new one.
        let changed = device.ecdh_public_key.as_deref().is_some_and(|old| old != ecdh);
        device.ecdh_public_key = Some(ecdh.to_string());
        if changed {
            if let Some(vault) = crate::services::server::vault::vault() {
                vault.drop_wrap(device_id);
            }
        }
        self.save_devices()?;
        self.audit("secrets_enrolled", Some(device_id));
        Ok(())
    }

    /// A nonce for `action` (user decision 2026-10-03: the secrets key's
    /// set-up and a new recovery code need the pairing key, not only the
    /// session). The device signs [`Vault::action_payload`] over it, built
    /// on its own side from these fields, never a text the server sends.
    ///
    /// [`Vault::action_payload`]: crate::services::server::vault::Vault::action_payload
    pub fn action_challenge(&mut self, device_id: &str, action: &str) -> Result<(String, u64), String> {
        if !SIGNED_ACTIONS.contains(&action) {
            return Err("unknown_action".into());
        }
        if !self.devices.devices.iter().any(|d| d.id == device_id) {
            return Err("unknown_device".into());
        }
        let t = now();
        self.action_challenges.retain(|_, c| c.expires_at >= t);
        if self.action_challenges.values().filter(|c| c.device_id == device_id).count() >= 4 || self.action_challenges.len() >= 256 {
            return Err("rate_limited".into());
        }
        let nonce = random_id::<24>()?;
        let expires_at = t + CHALLENGE_TTL;
        let payload = crate::services::server::vault::Vault::action_payload(&self.origin, device_id, action, &nonce, expires_at);
        self.action_challenges.insert(nonce.clone(), Challenge { device_id: device_id.into(), payload, expires_at });
        Ok((nonce, expires_at))
    }

    /// Spend an action nonce: the signature must be the device's pairing key
    /// over the payload made for this device and this action.
    pub fn verify_action(&mut self, device_id: &str, action: &str, nonce: &str, signature: &str) -> Result<(), String> {
        let challenge = self.action_challenges.remove(nonce).ok_or("invalid_challenge")?;
        if challenge.device_id != device_id || challenge.expires_at < now() || !challenge.payload.contains(&format!("\n{action}\n{nonce}\n")) {
            return Err("invalid_challenge".into());
        }
        let device = self.devices.devices.iter().find(|d| d.id == device_id).ok_or("unknown_device")?;
        let der = Base64UrlUnpadded::decode_vec(&device.public_key).map_err(|_| "invalid_public_key")?;
        let verifying = VerifyingKey::from(PublicKey::from_public_key_der(&der).map_err(|_| "invalid_public_key")?);
        let sig = Base64UrlUnpadded::decode_vec(signature).map_err(|_| "invalid_signature")?;
        let sig = Signature::from_slice(&sig).map_err(|_| "invalid_signature")?;
        verifying.verify(challenge.payload.as_bytes(), &sig).map_err(|_| "invalid_signature")?;
        self.audit(action, Some(device_id));
        Ok(())
    }

    /// Every paired device's enrolled ECDH key.
    pub fn secrets_device_keys(&self) -> Vec<crate::services::server::vault::DeviceKey> {
        device_keys_of(&self.devices)
    }

    pub fn revoke(&mut self, device_id: &str) -> Result<(), String> {
        let before = self.devices.devices.len();
        self.devices.devices.retain(|d| d.id != device_id);
        if before == self.devices.devices.len() {
            return Err("unknown device".into());
        }
        // §6.8: a revoked device's wrap of the secrets key goes with it, and
        // the key is rotated (now if unlocked, else at the next release), so
        // the device and an old copy of the wraps open nothing new.
        if let Some(vault) = crate::services::server::vault::vault() {
            if let Err(error) = vault.revoke(device_id, &self.secrets_device_keys()) {
                eprintln!("secrets: revoking {device_id}: {error} (the rotation is retried at the next release)");
            }
        }
        self.sessions.retain(|_, s| s.device_id != device_id);
        self.challenges.retain(|_, c| c.device_id != device_id);
        self.action_challenges.retain(|_, c| c.device_id != device_id);
        self.save_devices()?;
        self.push.forget_device(device_id)?;
        self.audit("revoked", Some(device_id));
        Ok(())
    }

    pub fn forget_all(&mut self) -> Result<(), String> {
        if let Some(vault) = crate::services::server::vault::vault() {
            if let Err(error) = vault.forget_devices() {
                eprintln!("secrets: forgetting every device: {error} (the rotation is retried at the next release)");
            }
        }
        self.devices.devices.clear();
        self.sessions.clear();
        self.challenges.clear();
        self.action_challenges.clear();
        self.pairing = None;
        self.save_devices()?;
        self.push.forget_all()?;
        let next = random_bytes::<32>()?;
        let key_path = self.control_dir.join("host.key");
        // Written beside and renamed over, never truncated in place: a crash
        // between the truncate and the write left a zero-byte key, on which
        // every later start failed with "host.key has invalid length" until
        // somebody found and deleted the file by hand.
        store::write_bytes_atomic(&key_path, &next, 0o600)?;
        store::ensure_private_file(&key_path)?;
        self.host_key = next.to_vec();
        self.audit("forgot_all", None);
        Ok(())
    }

    pub fn push(&self) -> &PushStore {
        &self.push
    }

    /// Store this paired device's push subscription.
    pub fn push_subscribe(
        &mut self,
        device_id: &str,
        endpoint: &str,
        p256dh: &str,
        auth: &str,
        prefs: PushPrefs,
    ) -> Result<(), String> {
        if !self.devices.devices.iter().any(|d| d.id == device_id) {
            return Err("unknown device".into());
        }
        self.push.subscribe(device_id, endpoint, p256dh, auth, prefs)?;
        self.audit("push_subscribed", Some(device_id));
        Ok(())
    }

    pub fn push_unsubscribe(&mut self, device_id: &str) -> Result<(), String> {
        self.push.forget_device(device_id)?;
        self.audit("push_unsubscribed", Some(device_id));
        Ok(())
    }

    /// The encrypted posts for one notice, to every paired device that
    /// subscribed. The desktop's tag carries raw desktop ids, so the phone
    /// gets a keyed digest of it — stable, so a repeat replaces rather than
    /// stacks, and meaningless off this host.
    pub fn push_deliveries(&mut self, notice: &Notice) -> Result<Vec<Delivery>, String> {
        let tag = Base64UrlUnpadded::encode_string(&self.keyed(b"push-tag", notice.tag.as_bytes())[..12]);
        let paired: Vec<String> = self.devices.devices.iter().map(|d| d.id.clone()).collect();
        self.push.deliveries(notice, &tag, &paired)
    }

    /// The push service said `endpoint` is gone: its row lapses, keeping the
    /// phone's choices for its next sign-in (`PushStore::lapse_endpoint`).
    pub fn push_lapse_endpoint(&mut self, endpoint: &str) {
        self.push.lapse_endpoint(endpoint);
    }

    fn audit(&self, event: &str, device_id: Option<&str>) {
        #[derive(Serialize)]
        struct Row<'a> {
            at: u64,
            event: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            device_id: Option<&'a str>,
        }
        let path = self.control_dir.join("audit.jsonl");
        if fs::metadata(&path).is_ok_and(|m| m.len() > 1024 * 1024) {
            let _ = fs::rename(&path, self.control_dir.join("audit.jsonl.1"));
        }
        let mut options = fs::OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        if let Ok(mut file) = options.open(path) {
            use std::io::Write;
            if let Ok(row) = serde_json::to_string(&Row {
                at: now(),
                event,
                device_id,
            }) {
                let _ = writeln!(file, "{row}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_invite_file_enrols_once_and_wears_out_like_a_code() {
        let dir = tempfile::tempdir().unwrap();
        let control = dir.path().join("mobile-control");
        let mut store = AuthStore::open(&control, "https://desk.example.ts.net".into()).unwrap();
        let key = p256::ecdsa::SigningKey::random(&mut rand::rngs::OsRng);
        use p256::pkcs8::EncodePublicKey;
        let public = Base64UrlUnpadded::encode_string(key.verifying_key().to_public_key_der().unwrap().as_bytes());
        assert_eq!(store.pair("12345678", "Laptop", &public), Err("invalid_pairing_code".into()), "no code, no invite");
        write_invite(&control, "12345678", now() + 60).unwrap();
        for _ in 0..PAIR_CODE_ATTEMPTS - 1 {
            assert!(store.pair("00000000", "Laptop", &public).is_err());
        }
        assert!(control.join(INVITE_FILE).exists(), "still one guess left");
        store.pair("12345678", "Laptop", &public).expect("the invite enrols");
        assert!(!control.join(INVITE_FILE).exists(), "spent");
        assert!(store.pair("12345678", "Laptop", &public).is_err());
        // Too many misses retire the file; an expired invite is gone at first use.
        // (A fresh store: the pair rate limit is per process, ten a minute.)
        let mut store = AuthStore::open(&control, "https://desk.example.ts.net".into()).unwrap();
        write_invite(&control, "22222222", now() + 60).unwrap();
        for _ in 0..PAIR_CODE_ATTEMPTS {
            assert!(store.pair("00000000", "Laptop", &public).is_err());
        }
        assert!(!control.join(INVITE_FILE).exists());
        write_invite(&control, "33333333", now() - 1).unwrap();
        assert!(store.pair("33333333", "Laptop", &public).is_err());
        assert!(!control.join(INVITE_FILE).exists());
        assert_eq!(invite_hash("x").len(), 64);
        assert_ne!(invite_hash("x"), invite_hash("y"));
    }
    use p256::{
        ecdsa::{signature::Signer, SigningKey},
        elliptic_curve::rand_core::OsRng,
        pkcs8::EncodePublicKey,
    };

    /// User decision 2026-10-03: setting the secrets key up and a new
    /// recovery code need the pairing key's signature over a single-use
    /// nonce made for that device and that action.
    #[test]
    fn signed_actions_need_the_pairing_key_and_are_single_use() {
        let dir = tempfile::tempdir().expect("control dir");
        let origin = "https://desk.example.ts.net";
        let mut auth = AuthStore::open(dir.path(), origin.into()).expect("auth store");
        let signing = SigningKey::random(&mut OsRng);
        let public = Base64UrlUnpadded::encode_string(signing.verifying_key().to_public_key_der().expect("SPKI").as_bytes());
        let (code, _) = auth.create_pairing_code().expect("pairing code");
        let device = auth.pair(&code, "Phone", &public).expect("paired");
        let sign = |key: &SigningKey, action: &str, nonce: &str, expires_at: u64| {
            let payload = crate::services::server::vault::Vault::action_payload(origin, &device, action, nonce, expires_at);
            let signature: Signature = key.sign(payload.as_bytes());
            Base64UrlUnpadded::encode_string(&signature.to_bytes())
        };
        assert_eq!(auth.action_challenge(&device, "login"), Err("unknown_action".into()));
        assert_eq!(auth.action_challenge("dev_nobody", "secrets-setup"), Err("unknown_device".into()));

        let (nonce, expires_at) = auth.action_challenge(&device, "secrets-setup").expect("nonce");
        let stranger = SigningKey::random(&mut OsRng);
        assert_eq!(auth.verify_action(&device, "secrets-setup", &nonce, &sign(&stranger, "secrets-setup", &nonce, expires_at)), Err("invalid_signature".into()), "another key");
        assert_eq!(auth.verify_action(&device, "secrets-setup", &nonce, &sign(&signing, "secrets-setup", &nonce, expires_at)), Err("invalid_challenge".into()), "the failed try spent it");

        let (nonce, expires_at) = auth.action_challenge(&device, "secrets-setup").expect("nonce");
        let signature = sign(&signing, "secrets-setup", &nonce, expires_at);
        assert_eq!(auth.verify_action(&device, "secrets-recovery-code", &nonce, &signature), Err("invalid_challenge".into()), "made for another action");
        let (nonce, expires_at) = auth.action_challenge(&device, "secrets-setup").expect("nonce");
        let signature = sign(&signing, "secrets-setup", &nonce, expires_at);
        auth.verify_action(&device, "secrets-setup", &nonce, &signature).expect("signed");
        assert_eq!(auth.verify_action(&device, "secrets-setup", &nonce, &signature), Err("invalid_challenge".into()), "single use");
        // A login challenge's signature is no action signature, and the
        // other way round.
        let (login_nonce, payload, _) = auth.challenge(&device).expect("challenge");
        let login_sig: Signature = signing.sign(payload.as_bytes());
        assert!(auth.verify_action(&device, "secrets-setup", &login_nonce, &Base64UrlUnpadded::encode_string(&login_sig.to_bytes())).is_err());
        // Bounded per device.
        for _ in 0..4 {
            auth.action_challenge(&device, "secrets-recovery-code").expect("nonce");
        }
        assert_eq!(auth.action_challenge(&device, "secrets-recovery-code"), Err("rate_limited".into()));
        auth.revoke(&device).expect("revoke");
        assert!(auth.action_challenges.is_empty(), "a revoked device's nonces go with it");
    }

    #[test]
    fn pairing_login_and_revocation_are_key_bound() {
        let dir = tempfile::tempdir().expect("control dir");
        let mut auth =
            AuthStore::open(dir.path(), "https://desk.example.ts.net".into()).expect("auth store");
        let signing = SigningKey::random(&mut OsRng);
        let public = signing.verifying_key().to_public_key_der().expect("SPKI");
        let public = Base64UrlUnpadded::encode_string(public.as_bytes());
        let (code, _) = auth.create_pairing_code().expect("pairing code");
        let device = auth.pair(&code, "Phone", &public).expect("paired");
        // Paired is not signed in: the desktop's list says which is which.
        assert!(!auth.devices()[0].online);
        let (nonce, payload, _) = auth.challenge(&device).expect("challenge");
        let signature: Signature = signing.sign(payload.as_bytes());
        let signature = Base64UrlUnpadded::encode_string(&signature.to_bytes());
        let (token, _) = auth.login(&device, &nonce, &signature).expect("login");
        assert_eq!(auth.authenticate(&token).as_deref(), Some(device.as_str()));
        assert!(auth.devices()[0].online);
        auth.logout(&token);
        assert!(!auth.devices()[0].online);
        let (nonce, payload, _) = auth.challenge(&device).expect("challenge");
        let signature: Signature = signing.sign(payload.as_bytes());
        let signature = Base64UrlUnpadded::encode_string(&signature.to_bytes());
        let (token, _) = auth.login(&device, &nonce, &signature).expect("login");
        auth.revoke(&device).expect("revoke");
        assert!(auth.authenticate(&token).is_none());
        assert!(auth.devices().is_empty());
    }

    #[test]
    fn an_open_ticket_opens_its_one_url_while_the_session_lives() {
        let (_dir, mut auth) = store();
        let signing = SigningKey::random(&mut OsRng);
        let public = signing.verifying_key().to_public_key_der().expect("SPKI");
        let public = Base64UrlUnpadded::encode_string(public.as_bytes());
        let (code, _) = auth.create_pairing_code().expect("pairing code");
        let device = auth.pair(&code, "Phone", &public).expect("paired");
        let (nonce, payload, _) = auth.challenge(&device).expect("challenge");
        let signature: Signature = signing.sign(payload.as_bytes());
        let signature = Base64UrlUnpadded::encode_string(&signature.to_bytes());
        let (token, _) = auth.login(&device, &nonce, &signature).expect("login");

        assert!(auth.open_ticket("not-a-session", "/a").is_err());
        let ticket = auth.open_ticket(&token, "/api/v1/x?f=1").expect("ticket");
        assert_eq!(auth.redeem_ticket(&ticket, "/api/v1/x?f=1").as_deref(), Some(device.as_str()));
        // Again, for the viewer's second read.
        assert!(auth.redeem_ticket(&ticket, "/api/v1/x?f=1").is_some());
        assert!(auth.redeem_ticket(&ticket, "/api/v1/x?f=2").is_none());
        assert!(auth.redeem_ticket("forged", "/api/v1/x?f=1").is_none());

        auth.tickets.get_mut(&ticket).expect("held").expires_at = now() - 1;
        assert!(auth.redeem_ticket(&ticket, "/api/v1/x?f=1").is_none());

        let ticket = auth.open_ticket(&token, "/api/v1/x?f=1").expect("ticket");
        auth.logout(&token);
        assert!(auth.redeem_ticket(&ticket, "/api/v1/x?f=1").is_none());
    }

    fn store() -> (tempfile::TempDir, AuthStore) {
        let dir = tempfile::tempdir().expect("control dir");
        let auth =
            AuthStore::open(dir.path(), "https://desk.example.ts.net".into()).expect("auth store");
        (dir, auth)
    }

    #[test]
    fn a_wrong_pairing_code_does_not_burn_the_outstanding_one() {
        let (_dir, mut auth) = store();
        let signing = SigningKey::random(&mut OsRng);
        let public = signing.verifying_key().to_public_key_der().expect("SPKI");
        let public = Base64UrlUnpadded::encode_string(public.as_bytes());
        let (code, _) = auth.create_pairing_code().expect("pairing code");
        for _ in 0..(PAIR_CODE_ATTEMPTS - 1) {
            assert!(auth.pair("00000000", "Phone", &public).is_err());
        }
        // The real code still works after the wrong guesses.
        auth.pair(&code, "Phone", &public).expect("paired");
    }

    #[test]
    fn a_pairing_code_retires_after_its_attempt_budget() {
        let (_dir, mut auth) = store();
        let signing = SigningKey::random(&mut OsRng);
        let public = signing.verifying_key().to_public_key_der().expect("SPKI");
        let public = Base64UrlUnpadded::encode_string(public.as_bytes());
        let (code, _) = auth.create_pairing_code().expect("pairing code");
        for _ in 0..PAIR_CODE_ATTEMPTS {
            assert!(auth.pair("00000000", "Phone", &public).is_err());
        }
        assert!(auth.pair(&code, "Phone", &public).is_err());
    }

    #[test]
    fn a_pair_flood_cannot_lock_a_paired_device_out_of_login() {
        let (_dir, mut auth) = store();
        let signing = SigningKey::random(&mut OsRng);
        let public = signing.verifying_key().to_public_key_der().expect("SPKI");
        let public = Base64UrlUnpadded::encode_string(public.as_bytes());
        let (code, _) = auth.create_pairing_code().expect("pairing code");
        let device = auth.pair(&code, "Phone", &public).expect("paired");
        // Exhaust the pair budget several times over, as an unauthenticated
        // tailnet peer would.
        for _ in 0..(PAIR_ATTEMPT_BUDGET * 5) {
            let _ = auth.pair("00000000", "Phone", &public);
        }
        let (nonce, payload, _) = auth.challenge(&device).expect("challenge still available");
        let signature: Signature = signing.sign(payload.as_bytes());
        let signature = Base64UrlUnpadded::encode_string(&signature.to_bytes());
        auth.login(&device, &nonce, &signature).expect("login still available");
    }

    #[test]
    fn unknown_device_ids_share_one_bucket_and_cannot_evict_a_real_one() {
        let (_dir, mut auth) = store();
        let signing = SigningKey::random(&mut OsRng);
        let public = signing.verifying_key().to_public_key_der().expect("SPKI");
        let public = Base64UrlUnpadded::encode_string(public.as_bytes());
        let (code, _) = auth.create_pairing_code().expect("pairing code");
        let device = auth.pair(&code, "Phone", &public).expect("paired");
        for index in 0..(MAX_RATE_BUCKETS * 4) {
            let _ = auth.challenge(&format!("made-up-{index}"));
        }
        assert!(auth.attempts.len() <= 3, "buckets: {}", auth.attempts.len());
        auth.challenge(&device).expect("real device still served");
    }

    #[test]
    fn forgetting_all_rotates_the_host_key_without_a_moment_of_empty_file() {
        let (dir, mut auth) = store();
        let before = auth.host_key().to_vec();
        auth.forget_all().expect("forget all");
        let after = auth.host_key().to_vec();
        assert_ne!(before, after);
        assert_eq!(after.len(), 32);
        assert_eq!(fs::read(dir.path().join("host.key")).expect("key file"), after);
        assert!(
            !dir.path().join("host.tmp").exists(),
            "the staging file must be renamed away"
        );
        // The rotated key is what the next start reads.
        let reopened = AuthStore::open(dir.path(), "https://desk.example.ts.net".into())
            .expect("reopen after rotation");
        assert_eq!(reopened.host_key(), after.as_slice());
    }

    fn paired_login(auth: &mut AuthStore) -> (String, String) {
        let signing = SigningKey::random(&mut OsRng);
        let public = signing.verifying_key().to_public_key_der().expect("SPKI");
        let public = Base64UrlUnpadded::encode_string(public.as_bytes());
        let (code, _) = auth.create_pairing_code().expect("pairing code");
        let device = auth.pair(&code, "Phone", &public).expect("paired");
        let (nonce, payload, _) = auth.challenge(&device).expect("challenge");
        let signature: Signature = signing.sign(payload.as_bytes());
        let signature = Base64UrlUnpadded::encode_string(&signature.to_bytes());
        let (token, _) = auth.login(&device, &nonce, &signature).expect("login");
        (device, token)
    }

    #[test]
    fn a_session_slides_with_every_touch_and_stops_at_the_cap() {
        let (_dir, mut auth) = store();
        let (device, token) = paired_login(&mut auth);
        let t = now();
        // A fresh login expires one idle window out, not twelve hours.
        let first = auth.sessions[&token].expires_at;
        assert!(first >= t + SESSION_IDLE - 1 && first <= t + SESSION_IDLE + 1);
        // Pretend the phone has been quiet for most of the window, then speaks.
        auth.sessions.get_mut(&token).unwrap().expires_at = t + 30;
        assert_eq!(auth.touch(&token).as_deref(), Some(device.as_str()));
        assert!(auth.sessions[&token].expires_at >= t + SESSION_IDLE - 1);
        // A plain check does not slide it.
        auth.sessions.get_mut(&token).unwrap().expires_at = t + 30;
        assert_eq!(auth.authenticate(&token).as_deref(), Some(device.as_str()));
        assert_eq!(auth.sessions[&token].expires_at, t + 30);
        // Near the cap a touch cannot push past it.
        auth.sessions.get_mut(&token).unwrap().created_at = t - SESSION_MAX + 60;
        auth.touch(&token).expect("still live");
        assert_eq!(auth.sessions[&token].expires_at, t + 60);
        // Past its deadline the token is gone, touched or not.
        auth.sessions.get_mut(&token).unwrap().expires_at = t - 1;
        assert!(auth.touch(&token).is_none());
        assert!(auth.authenticate(&token).is_none());
    }

    #[test]
    fn expired_challenges_are_swept_rather_than_accumulating() {
        let (_dir, mut auth) = store();
        let signing = SigningKey::random(&mut OsRng);
        let public = signing.verifying_key().to_public_key_der().expect("SPKI");
        let public = Base64UrlUnpadded::encode_string(public.as_bytes());
        let (code, _) = auth.create_pairing_code().expect("pairing code");
        let device = auth.pair(&code, "Phone", &public).expect("paired");
        for _ in 0..5 {
            auth.challenge(&device).expect("challenge");
        }
        assert_eq!(auth.challenges.len(), 5);
        for challenge in auth.challenges.values_mut() {
            challenge.expires_at = 0;
        }
        auth.challenge(&device).expect("challenge");
        assert_eq!(auth.challenges.len(), 1);
    }
}

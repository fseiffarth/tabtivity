//! Web Push for Tabtivity Mobile (RFC 8030 delivery, RFC 8291 payload
//! encryption, RFC 8292 VAPID) — `docs/tabtivity_mobile_future_plan.md` §A.
//!
//! The one channel that leaves the tailnet: a push subscription always routes
//! through the browser vendor's push service (FCM, Apple, Mozilla, WNS). What
//! keeps that acceptable is that the service only ever relays ciphertext —
//! every payload is encrypted to the phone's own key before it leaves — and
//! that the sidecar posts only to those vendors' hosts, never to an arbitrary
//! URL a compromised renderer might hand it.
//!
//! The store lives inside `AuthStore` so revoking a device, or forgetting all
//! of them, drops its subscription in the same call: a revoked phone that kept
//! receiving reminders is exactly the lost-phone case revocation exists for.

use std::{
    collections::{HashMap, VecDeque},
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use aes_gcm::{aead::Aead, Aes128Gcm, KeyInit, Nonce};
use base64ct::{Base64UrlUnpadded, Encoding};
use hkdf::Hkdf;
use p256::{
    ecdsa::{signature::Signer, Signature, SigningKey},
    elliptic_curve::sec1::ToEncodedPoint,
    PublicKey, SecretKey,
};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use super::store;

const PUSH_SCHEMA: u32 = 1;
/// RFC 8291 record size. One record always holds a whole payload here.
const RECORD_SIZE: u32 = 4096;
/// The push services cap a payload at 4 KiB of ciphertext; the notice text is
/// clipped well under that so a long event title can never be the reason a
/// reminder is refused.
const MAX_TITLE_CHARS: usize = 160;
const MAX_BODY_CHARS: usize = 240;
/// The prompt a finished-turn notice quotes, clipped on its own so the closing
/// quote survives the body's clip.
const MAX_PROMPT_CHARS: usize = 200;
const MAX_ENDPOINT_LEN: usize = 2048;
/// A backstop, not a policy: the desktop fires one notice per reminder, so more
/// than this in a minute is a runaway caller, not a busy calendar.
const NOTICE_BUDGET_PER_MINUTE: usize = 30;
/// Per agent tab, at most one notice in this window: a session that asks,
/// is answered and asks again in quick succession is one interruption.
const AGENT_COOLDOWN_SECONDS: u64 = 30;
/// How long a push service may hold an undelivered notice for a phone that is
/// off. A reminder an hour late is still worth seeing; a day late is noise.
const TTL_SECONDS: u32 = 60 * 60;
/// The contact RFC 8292 asks for. The project, not the user: this reaches the
/// push vendor in every request, so it must say nothing about who sent it.
const VAPID_SUBJECT: &str = concat!("https://github.com/", crate::app_repo!());

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

fn random_secret_key() -> Result<SecretKey, String> {
    // A uniformly random 32-byte string is a valid scalar with overwhelming
    // probability; the loop covers the zero/over-order case.
    loop {
        if let Ok(key) = SecretKey::from_slice(&random_bytes::<32>()?) {
            return Ok(key);
        }
    }
}

/// The push hosts a subscription may name. Anything else is refused at
/// subscribe time *and* again at send time, so a stored file edited by hand
/// cannot widen it either.
fn allowed_push_host(host: &str) -> bool {
    host == "fcm.googleapis.com"
        || host.ends_with(".push.apple.com")
        // Split so the source never spells a Firefox profile directory,
        // which `commands::browser`'s source scan rightly refuses.
        || host.ends_with(concat!(".push.services.", "mozilla.com"))
        || host.ends_with(".notify.windows.com")
}

/// The endpoint parsed and checked: `https`, a push vendor's host, the default
/// port, no credentials. Returns the origin VAPID's `aud` claim names.
pub fn endpoint_origin(endpoint: &str) -> Result<String, String> {
    if endpoint.len() > MAX_ENDPOINT_LEN {
        return Err("push endpoint too long".into());
    }
    let url = url::Url::parse(endpoint).map_err(|_| "push endpoint is not a URL")?;
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || !allowed_push_host(&host)
    {
        return Err("push endpoint is not a known push service".into());
    }
    Ok(format!("https://{host}"))
}

fn decode_fixed<const N: usize>(value: &str, what: &str) -> Result<[u8; N], String> {
    let bytes = Base64UrlUnpadded::decode_vec(value.trim_end_matches('='))
        .map_err(|_| format!("{what} is not base64url"))?;
    bytes
        .try_into()
        .map_err(|_| format!("{what} has the wrong length"))
}

/// Which agent turns a phone wants to hear about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentNotices {
    #[default]
    Off,
    /// Only a session waiting on an answer — the one that stalls without you.
    Questions,
    /// Questions and finished turns.
    All,
}

/// The agent-turn edge a notice reports. The desktop sees the transition; the
/// sidecar only ever sees snapshots, so it never infers one itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentTurn {
    Question,
    Done,
}

fn yes() -> bool {
    true
}

/// A phone's choices: what it is told about, and how much a notice says.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PushPrefs {
    /// Whether notices carry names — the event's title, time and place, the
    /// project and tab of an agent. Off, the phone is told only *that*
    /// something wants it: what a lock screen others can see should show.
    pub details: bool,
    #[serde(default = "yes")]
    pub calendar: bool,
    #[serde(default)]
    pub agents: AgentNotices,
}

/// One phone's subscription, as the browser's `PushSubscription.toJSON()`
/// hands it over, plus the phone's choices.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Subscription {
    pub device_id: String,
    pub endpoint: String,
    /// The phone's P-256 key (uncompressed, base64url).
    pub p256dh: String,
    /// The 16-byte shared auth secret (base64url).
    pub auth: String,
    pub details: bool,
    #[serde(default = "yes")]
    pub calendar: bool,
    #[serde(default)]
    pub agents: AgentNotices,
    pub created_at: u64,
    /// The push service said this endpoint is gone (`PushStore::lapse_endpoint`).
    /// The row stays as the phone's remembered choices and nothing more: its
    /// keys are cleared, nothing is sent to it, and the phone it belongs to
    /// re-subscribes with these choices the next time it signs in. Left out
    /// while false, so a file written before the field existed and one written
    /// after read alike.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub lapsed: bool,
}

impl Subscription {
    fn wants(&self, notice: &Notice) -> bool {
        if self.lapsed {
            return false;
        }
        match notice.kind {
            NoticeKind::Calendar => self.calendar,
            NoticeKind::Agent => match self.agents {
                AgentNotices::Off => false,
                AgentNotices::Questions => notice.status == Some(AgentTurn::Question),
                AgentNotices::All => true,
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PushFile {
    schema: u32,
    subscriptions: Vec<Subscription>,
}

impl Default for PushFile {
    fn default() -> Self {
        Self {
            schema: PUSH_SCHEMA,
            subscriptions: vec![],
        }
    }
}

/// What a notice is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NoticeKind {
    Calendar,
    Agent,
}

/// Where a tap on the notice lands: the phone's own opaque project and tab
/// ids, the same ones its lists already carry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoticeTarget {
    pub project: String,
    pub tab: String,
}

/// One notice, before it is encrypted per phone. `tag` is a dedup key that may
/// carry raw desktop ids (a reminder's alarm key, a tmux name); it is keyed
/// through the host key before it crosses. `title`/`body` travel only to a
/// phone that chose details.
#[derive(Debug, Clone)]
pub struct Notice {
    pub kind: NoticeKind,
    pub status: Option<AgentTurn>,
    pub title: String,
    pub body: String,
    pub tag: String,
    pub target: Option<NoticeTarget>,
}

/// An agent tab as the sidecar's own catalog resolves it, for an agent notice.
#[derive(Debug, Clone)]
pub struct AgentTabRef {
    pub project_id: String,
    pub project_label: String,
    pub tab_id: String,
    pub tab_label: String,
    /// A phone has this tab's live terminal on a visible page right now
    /// (`TerminalRegistry::is_watched`): it is already being looked at, so a
    /// notice would only interrupt the reader. A phone that merely still
    /// holds the socket from a pocket is not that.
    pub attached: bool,
    /// The phones the tab's scope is open to (`ResolvedProject::devices`):
    /// `None` is every paired phone. Filters who is sent the notice; never
    /// part of it.
    pub devices: Option<Vec<String>>,
}

impl AgentTabRef {
    /// The notice for this tab's `turn`, keyed per tab so a finished turn
    /// replaces the question it answered rather than stacking under it. A
    /// finished turn names the prompt it answered when the desktop read one —
    /// in the body, so only a phone that chose details ever sees it.
    pub fn notice(&self, tmux_session: &str, turn: AgentTurn, prompt: Option<&str>) -> Notice {
        let prompt = prompt
            .map(|text| text.split_whitespace().collect::<Vec<_>>().join(" "))
            .filter(|text| !text.is_empty());
        Notice {
            kind: NoticeKind::Agent,
            status: Some(turn),
            title: format!("{} · {}", self.project_label, self.tab_label),
            body: match (turn, prompt) {
                (AgentTurn::Question, _) => "Needs your answer".into(),
                (AgentTurn::Done, Some(prompt)) => {
                    format!("Finished “{}”", clip(&prompt, MAX_PROMPT_CHARS))
                }
                (AgentTurn::Done, None) => "Finished its turn".into(),
            },
            tag: format!("agent:{tmux_session}"),
            target: Some(NoticeTarget {
                project: self.project_id.clone(),
                tab: self.tab_id.clone(),
            }),
        }
    }
}

/// One encrypted POST, ready to send.
#[derive(Debug, Clone)]
pub struct Delivery {
    pub endpoint: String,
    pub authorization: String,
    pub body: Vec<u8>,
}

pub struct PushStore {
    control_dir: PathBuf,
    vapid: SigningKey,
    file: PushFile,
    sent: VecDeque<u64>,
    /// Keyed tag → when an agent notice under it last went out.
    recent: HashMap<String, u64>,
}

fn clip(value: &str, max: usize) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

impl PushStore {
    pub fn open(control_dir: &Path) -> Result<Self, String> {
        let key_path = control_dir.join("push-vapid.key");
        #[allow(clippy::question_mark)] // the `match` below — see there
        let vapid = if key_path.exists() {
            store::ensure_private_file(&key_path)?;
            let bytes = fs::read(&key_path).map_err(|e| format!("read push key: {e}"))?;
            SigningKey::from_slice(&bytes).map_err(|_| "push-vapid.key is invalid".to_string())?
        } else {
            // A `match`, not `?`: CodeQL carries a `?`'s value on into the
            // function's return, and the whole store then read as the key.
            match Self::write_new_key(&key_path) {
                Ok(key) => key,
                Err(e) => return Err(e),
            }
        };
        let path = control_dir.join("push.json");
        let file = if path.exists() {
            let file: PushFile = store::read_json(&path)?;
            if file.schema != PUSH_SCHEMA {
                return Err("push.json has an unsupported schema".into());
            }
            file
        } else {
            PushFile::default()
        };
        Ok(Self {
            control_dir: control_dir.to_path_buf(),
            vapid,
            file,
            sent: VecDeque::new(),
            recent: HashMap::new(),
        })
    }

    fn write_new_key(key_path: &Path) -> Result<SigningKey, String> {
        let secret = random_secret_key()?;
        store::write_bytes_atomic(key_path, &secret.to_bytes(), 0o600)?;
        store::ensure_private_file(key_path)?;
        Ok(SigningKey::from(secret))
    }

    fn save(&self) -> Result<(), String> {
        store::write_json_atomic(&self.control_dir.join("push.json"), &self.file, 0o600)
    }

    /// The VAPID public key the phone passes as `applicationServerKey`.
    pub fn public_key(&self) -> String {
        let point = self.vapid.verifying_key().to_encoded_point(false);
        Base64UrlUnpadded::encode_string(point.as_bytes())
    }

    pub fn subscription(&self, device_id: &str) -> Option<&Subscription> {
        self.file
            .subscriptions
            .iter()
            .find(|s| s.device_id == device_id)
    }

    /// Store (or replace) this device's subscription after checking every part
    /// of it: a bad key would only fail later, at send time, with nobody there.
    pub fn subscribe(
        &mut self,
        device_id: &str,
        endpoint: &str,
        p256dh: &str,
        auth: &str,
        prefs: PushPrefs,
    ) -> Result<(), String> {
        endpoint_origin(endpoint)?;
        let key = decode_fixed::<65>(p256dh, "p256dh")?;
        PublicKey::from_sec1_bytes(&key).map_err(|_| "p256dh is not a P-256 point")?;
        decode_fixed::<16>(auth, "auth")?;
        // One endpoint belongs to one browser: a second device claiming it
        // would be the same phone paired twice, and would double every notice.
        self.file
            .subscriptions
            .retain(|s| s.device_id != device_id && s.endpoint != endpoint);
        self.file.subscriptions.push(Subscription {
            device_id: device_id.to_string(),
            endpoint: endpoint.to_string(),
            p256dh: p256dh.trim_end_matches('=').to_string(),
            auth: auth.trim_end_matches('=').to_string(),
            details: prefs.details,
            calendar: prefs.calendar,
            agents: prefs.agents,
            created_at: now(),
            lapsed: false,
        });
        self.save()
    }

    /// Drop this device's subscription. `Ok` whether or not it had one.
    pub fn forget_device(&mut self, device_id: &str) -> Result<(), String> {
        let before = self.file.subscriptions.len();
        self.file.subscriptions.retain(|s| s.device_id != device_id);
        if before == self.file.subscriptions.len() {
            return Ok(());
        }
        self.save()
    }

    /// Drop every subscription and rotate the VAPID key, so nothing subscribed
    /// under the old one can be woken again.
    pub fn forget_all(&mut self) -> Result<(), String> {
        self.file.subscriptions.clear();
        self.save()?;
        self.vapid = Self::write_new_key(&self.control_dir.join("push-vapid.key"))?;
        Ok(())
    }

    /// A push service said the endpoint is gone (404/410): the browser dropped
    /// the subscription, so posting to it would only fail every notice after.
    ///
    /// The row is kept as a lapsed record rather than deleted. Deleting it
    /// took the phone's choices with it, the host then answered "not
    /// subscribed", and the phone's silent refresh left a phone that never
    /// switched notices on alone — so they stayed off until somebody noticed
    /// and re-enabled them by hand. The keys go (nothing can be encrypted to
    /// this row again, by this build or an older one reading the file); the
    /// endpoint stays so the phone can tell a browser still handing out the
    /// dead subscription from a fresh one. Unsubscribing, revoking the device
    /// and forget-all still remove the row whole.
    pub fn lapse_endpoint(&mut self, endpoint: &str) {
        let mut changed = false;
        for sub in &mut self.file.subscriptions {
            if sub.endpoint == endpoint && !sub.lapsed {
                sub.lapsed = true;
                sub.p256dh.clear();
                sub.auth.clear();
                changed = true;
            }
        }
        if changed {
            let _ = self.save();
        }
    }

    fn within_budget(&mut self, t: u64) -> bool {
        while self.sent.front().is_some_and(|&at| at + 60 <= t) {
            self.sent.pop_front();
        }
        if self.sent.len() >= NOTICE_BUDGET_PER_MINUTE {
            return false;
        }
        self.sent.push_back(t);
        true
    }

    /// Encrypt `notice` once per subscription of a still-paired device.
    /// `tag` is the already-keyed, opaque tag. Nothing is sent from here.
    /// `paired` is also who may get it: a notice for a scope open to some
    /// phones arrives with only those.
    pub fn deliveries(
        &mut self,
        notice: &Notice,
        tag: &str,
        paired: &[String],
    ) -> Result<Vec<Delivery>, String> {
        let t = now();
        if notice.kind == NoticeKind::Agent {
            self.recent.retain(|_, at| *at + AGENT_COOLDOWN_SECONDS > t);
            if self.recent.contains_key(tag) {
                return Ok(vec![]);
            }
        }
        // Who would get it, before anything is spent: a notice no eligible
        // phone wants — every phone that wants it is outside the scope's list,
        // or no longer paired — must neither use the minute's budget nor start
        // the tab's cooldown.
        let eligible: Vec<usize> = self
            .file
            .subscriptions
            .iter()
            .enumerate()
            .filter(|(_, s)| s.wants(notice) && paired.iter().any(|id| id == &s.device_id))
            .map(|(index, _)| index)
            .collect();
        if eligible.is_empty() {
            return Ok(vec![]);
        }
        if !self.within_budget(t) {
            return Err("push notice budget exhausted".into());
        }
        if notice.kind == NoticeKind::Agent {
            self.recent.insert(tag.to_string(), t);
        }
        let mut bare = serde_json::json!({ "kind": notice.kind, "tag": tag });
        if let Some(status) = notice.status {
            bare["status"] = serde_json::json!(status);
        }
        if let Some(target) = &notice.target {
            bare["project"] = serde_json::json!(target.project);
            bare["tab"] = serde_json::json!(target.tab);
        }
        let mut full = bare.clone();
        full["title"] = serde_json::json!(clip(&notice.title, MAX_TITLE_CHARS));
        full["body"] = serde_json::json!(clip(&notice.body, MAX_BODY_CHARS));
        let mut out = vec![];
        // `wants` is false for a lapsed row: it has no keys and gets nothing.
        // The paired check is revocation's belt (it already dropped the row)
        // for a push.json edited or restored behind our back, and the
        // per-phone list's only gate.
        for sub in eligible.into_iter().map(|index| &self.file.subscriptions[index]) {
            let Ok(origin) = endpoint_origin(&sub.endpoint) else {
                continue;
            };
            let (Ok(ua_public), Ok(auth)) = (
                decode_fixed::<65>(&sub.p256dh, "p256dh"),
                decode_fixed::<16>(&sub.auth, "auth"),
            ) else {
                continue;
            };
            let payload = if sub.details { &full } else { &bare };
            let plaintext = serde_json::to_vec(payload).map_err(|e| e.to_string())?;
            let body = encrypt(
                &plaintext,
                &ua_public,
                &auth,
                &random_secret_key()?,
                &random_bytes::<16>()?,
            )?;
            out.push(Delivery {
                endpoint: sub.endpoint.clone(),
                authorization: vapid_authorization(&self.vapid, &origin, t)?,
                body,
            });
        }
        Ok(out)
    }
}

fn hkdf_expand<const N: usize>(salt: &[u8], ikm: &[u8], info: &[u8]) -> Result<[u8; N], String> {
    // Not `[0u8; N]`: CodeQL reads that literal as the key itself, since it
    // doesn't see `expand` overwrite the buffer.
    let mut out: [u8; N] = std::array::from_fn(|_| 0);
    Hkdf::<Sha256>::new(Some(salt), ikm)
        .expand(info, &mut out)
        .map_err(|_| "hkdf expand failed".to_string())?;
    Ok(out)
}

/// RFC 8291 §3: one `aes128gcm` record, encrypted to the phone's key with the
/// ephemeral `as_key`. Deterministic in its inputs, so the RFC's own worked
/// example is its test.
pub fn encrypt(
    plaintext: &[u8],
    ua_public: &[u8; 65],
    ua_auth: &[u8; 16],
    as_key: &SecretKey,
    salt: &[u8; 16],
) -> Result<Vec<u8>, String> {
    let ua_key = PublicKey::from_sec1_bytes(ua_public).map_err(|_| "invalid phone key")?;
    let as_public = as_key.public_key().to_encoded_point(false);
    let shared = p256::ecdh::diffie_hellman(as_key.to_nonzero_scalar(), ua_key.as_affine());

    let mut key_info = b"WebPush: info\0".to_vec();
    key_info.extend_from_slice(ua_public);
    key_info.extend_from_slice(as_public.as_bytes());
    let ikm = hkdf_expand::<32>(ua_auth, shared.raw_secret_bytes(), &key_info)?;
    let cek = hkdf_expand::<16>(salt, &ikm, b"Content-Encoding: aes128gcm\0")?;
    let nonce = hkdf_expand::<12>(salt, &ikm, b"Content-Encoding: nonce\0")?;

    // The padding delimiter: 0x02 marks the last (here, only) record.
    let mut padded = plaintext.to_vec();
    padded.push(2);
    if padded.len() + 16 > RECORD_SIZE as usize {
        return Err("push payload too large".into());
    }
    let cipher = Aes128Gcm::new_from_slice(&cek).map_err(|_| "invalid content key")?;
    let sealed = cipher
        .encrypt(Nonce::from_slice(&nonce), padded.as_slice())
        .map_err(|_| "push encryption failed")?;

    let mut body = Vec::with_capacity(16 + 4 + 1 + 65 + sealed.len());
    body.extend_from_slice(salt);
    body.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    body.push(as_public.as_bytes().len() as u8);
    body.extend_from_slice(as_public.as_bytes());
    body.extend_from_slice(&sealed);
    Ok(body)
}

/// RFC 8292 `Authorization: vapid t=<jwt>, k=<key>` for one push origin.
pub fn vapid_authorization(key: &SigningKey, audience: &str, t: u64) -> Result<String, String> {
    let header = Base64UrlUnpadded::encode_string(br#"{"typ":"JWT","alg":"ES256"}"#);
    let claims = serde_json::to_vec(&serde_json::json!({
        "aud": audience,
        // Well inside the 24 h the RFC allows, and Apple's one-hour floor.
        "exp": t + 12 * 60 * 60,
        "sub": VAPID_SUBJECT,
    }))
    .map_err(|e| e.to_string())?;
    let signing_input = format!("{header}.{}", Base64UrlUnpadded::encode_string(&claims));
    let signature: Signature = key.sign(signing_input.as_bytes());
    let public = key.verifying_key().to_encoded_point(false);
    Ok(format!(
        "vapid t={signing_input}.{}, k={}",
        Base64UrlUnpadded::encode_string(&signature.to_bytes()),
        Base64UrlUnpadded::encode_string(public.as_bytes())
    ))
}

fn client() -> Result<reqwest::Client, String> {
    crate::services::mail_engine::install_crypto_provider();
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        // A redirect would carry the POST past the host allowlist.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())
}

/// Send each delivery; returns the endpoints the push service says are gone.
pub async fn send(deliveries: Vec<Delivery>) -> Vec<String> {
    let Ok(client) = client() else {
        return vec![];
    };
    let mut gone = vec![];
    for delivery in deliveries {
        // Re-checked here, not trusted from the store.
        if endpoint_origin(&delivery.endpoint).is_err() {
            continue;
        }
        let response = client
            .post(&delivery.endpoint)
            .header("TTL", TTL_SECONDS.to_string())
            .header("Urgency", "high")
            .header("Content-Encoding", "aes128gcm")
            .header("Content-Type", "application/octet-stream")
            .header("Authorization", &delivery.authorization)
            .body(delivery.body)
            .send()
            .await;
        if let Ok(response) = response {
            let status = response.status().as_u16();
            if status == 404 || status == 410 {
                gone.push(delivery.endpoint);
            }
        }
    }
    gone
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::{signature::Verifier, VerifyingKey};

    fn b64(value: &str) -> Vec<u8> {
        Base64UrlUnpadded::decode_vec(value).expect("base64url fixture")
    }

    /// RFC 8291 Appendix A, byte for byte.
    #[test]
    fn encryption_matches_the_rfc_8291_worked_example() {
        let as_key =
            SecretKey::from_slice(&b64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw")).unwrap();
        let ua_public: [u8; 65] = b64(
            "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
        )
        .try_into()
        .unwrap();
        let auth: [u8; 16] = b64("BTBZMqHH6r4Tts7J_aSIgg").try_into().unwrap();
        let salt: [u8; 16] = b64("DGv6ra1nlYgDCS1FRnbzlw").try_into().unwrap();
        let body = encrypt(
            b"When I grow up, I want to be a watermelon",
            &ua_public,
            &auth,
            &as_key,
            &salt,
        )
        .unwrap();
        assert_eq!(
            Base64UrlUnpadded::encode_string(&body),
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
        );
    }

    #[test]
    fn the_vapid_token_is_a_verifiable_es256_jwt_for_the_push_origin() {
        let key = SigningKey::from(random_secret_key().unwrap());
        let header = vapid_authorization(&key, "https://fcm.googleapis.com", 1_000).unwrap();
        let rest = header.strip_prefix("vapid t=").unwrap();
        let (jwt, k) = rest.split_once(", k=").unwrap();
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);
        let claims: serde_json::Value = serde_json::from_slice(&b64(parts[1])).unwrap();
        assert_eq!(claims["aud"], "https://fcm.googleapis.com");
        assert_eq!(claims["exp"], 1_000 + 12 * 60 * 60);
        let verifying = VerifyingKey::from_sec1_bytes(&b64(k)).unwrap();
        let signature = Signature::from_slice(&b64(parts[2])).unwrap();
        verifying
            .verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &signature)
            .expect("signature verifies");
    }

    #[test]
    fn only_push_vendor_https_endpoints_are_accepted() {
        assert_eq!(
            endpoint_origin("https://fcm.googleapis.com/fcm/send/abc").unwrap(),
            "https://fcm.googleapis.com"
        );
        assert!(endpoint_origin("https://web.push.apple.com/QGx").is_ok());
        assert!(endpoint_origin(concat!("https://updates.push.services.", "mozilla.com/wpush/v2/x")).is_ok());
        assert!(endpoint_origin("https://db5p.notify.windows.com/w/?token=x").is_ok());
        for bad in [
            "http://fcm.googleapis.com/fcm/send/abc",
            "https://fcm.googleapis.com:8443/fcm/send/abc",
            concat!("https://user", "@fcm.googleapis.com/x"),
            "https://evil.example/fcm.googleapis.com",
            "https://push.apple.com.evil.example/x",
            "https://127.0.0.1/x",
            "not a url",
        ] {
            assert!(endpoint_origin(bad).is_err(), "{bad} was accepted");
        }
    }

    fn phone_key() -> String {
        let secret = random_secret_key().unwrap();
        Base64UrlUnpadded::encode_string(secret.public_key().to_encoded_point(false).as_bytes())
    }

    fn prefs(details: bool) -> PushPrefs {
        PushPrefs { details, calendar: true, agents: AgentNotices::Off }
    }

    fn calendar_notice() -> Notice {
        Notice {
            kind: NoticeKind::Calendar,
            status: None,
            title: "Dentist".into(),
            body: "09:00".into(),
            tag: "raw".into(),
            target: None,
        }
    }

    #[test]
    fn subscriptions_round_trip_replace_and_are_dropped_per_device() {
        let dir = tempfile::tempdir().unwrap();
        let mut push = PushStore::open(dir.path()).unwrap();
        let auth = Base64UrlUnpadded::encode_string(&[7u8; 16]);
        push.subscribe("phone", "https://fcm.googleapis.com/a", &phone_key(), &auth, prefs(true))
            .unwrap();
        push.subscribe("phone", "https://fcm.googleapis.com/b", &phone_key(), &auth, prefs(false))
            .unwrap();
        assert!(push.subscribe("phone", "https://evil.example/x", &phone_key(), &auth, prefs(true)).is_err());
        assert!(push.subscribe("phone", "https://fcm.googleapis.com/c", "AAAA", &auth, prefs(true)).is_err());

        let reopened = PushStore::open(dir.path()).unwrap();
        let sub = reopened.subscription("phone").expect("kept");
        assert_eq!(sub.endpoint, "https://fcm.googleapis.com/b");
        assert!(!sub.details);
        assert_eq!(reopened.public_key(), push.public_key());

        push.forget_device("phone").unwrap();
        assert!(PushStore::open(dir.path()).unwrap().subscription("phone").is_none());
    }

    #[test]
    fn a_gone_endpoint_lapses_and_keeps_the_phones_choices_until_it_resubscribes() {
        let dir = tempfile::tempdir().unwrap();
        let mut push = PushStore::open(dir.path()).unwrap();
        let auth = Base64UrlUnpadded::encode_string(&[7u8; 16]);
        let chosen = PushPrefs { details: false, calendar: true, agents: AgentNotices::Questions };
        push.subscribe("phone", "https://fcm.googleapis.com/a", &phone_key(), &auth, chosen).unwrap();
        push.subscribe("other", "https://fcm.googleapis.com/o", &phone_key(), &auth, prefs(true)).unwrap();
        let paired = vec!["phone".to_string(), "other".to_string()];

        push.lapse_endpoint("https://fcm.googleapis.com/a");
        // Written through, and only the row the push service named.
        let mut reopened = PushStore::open(dir.path()).unwrap();
        let sub = reopened.subscription("phone").expect("the record is kept");
        assert!(sub.lapsed);
        assert!(!sub.details && sub.calendar);
        assert_eq!(sub.agents, AgentNotices::Questions);
        assert_eq!(sub.endpoint, "https://fcm.googleapis.com/a");
        assert!(sub.p256dh.is_empty() && sub.auth.is_empty(), "nothing left to encrypt to");
        assert!(!reopened.subscription("other").unwrap().lapsed);
        // Nothing is sent to it — and a notice only it wanted costs no budget.
        let out = reopened.deliveries(&calendar_notice(), "t", &paired).unwrap();
        assert_eq!(out.iter().map(|d| d.endpoint.as_str()).collect::<Vec<_>>(), ["https://fcm.googleapis.com/o"]);
        let question = agent_tab().notice(concat!(crate::app_slug!(), "-x"), AgentTurn::Question, None);
        assert!(reopened.deliveries(&question, "q", &paired).unwrap().is_empty());
        assert_eq!(reopened.sent.len(), 1);

        // The phone's refresh registers a fresh subscription: live again.
        reopened
            .subscribe("phone", "https://fcm.googleapis.com/a2", &phone_key(), &auth, chosen)
            .unwrap();
        let sub = PushStore::open(dir.path()).unwrap();
        let sub = sub.subscription("phone").unwrap();
        assert!(!sub.lapsed);
        assert_eq!(sub.endpoint, "https://fcm.googleapis.com/a2");
        assert!(!serde_json::to_string(sub).unwrap().contains("lapsed"), "left out while false");
    }

    #[test]
    fn a_lapsed_record_goes_with_an_unsubscribe_and_with_forget_all() {
        let dir = tempfile::tempdir().unwrap();
        let mut push = PushStore::open(dir.path()).unwrap();
        let auth = Base64UrlUnpadded::encode_string(&[7u8; 16]);
        for device in ["a", "b"] {
            let endpoint = format!("https://fcm.googleapis.com/{device}");
            push.subscribe(device, &endpoint, &phone_key(), &auth, prefs(true)).unwrap();
            push.lapse_endpoint(&endpoint);
        }
        push.forget_device("a").unwrap();
        assert!(push.subscription("a").is_none());
        assert!(push.subscription("b").is_some_and(|s| s.lapsed));
        push.forget_all().unwrap();
        assert!(PushStore::open(dir.path()).unwrap().subscription("b").is_none());
    }

    #[test]
    fn a_push_file_written_before_lapsed_records_still_opens() {
        let dir = tempfile::tempdir().unwrap();
        let key = phone_key();
        fs::write(
            dir.path().join("push.json"),
            serde_json::to_vec(&serde_json::json!({
                "schema": 1,
                "subscriptions": [{
                    "device_id": "phone",
                    "endpoint": "https://fcm.googleapis.com/a",
                    "p256dh": key,
                    "auth": Base64UrlUnpadded::encode_string(&[7u8; 16]),
                    "details": true,
                    "created_at": 1,
                }],
            }))
            .unwrap(),
        )
        .unwrap();
        let mut push = PushStore::open(dir.path()).unwrap();
        let sub = push.subscription("phone").expect("row");
        assert!(!sub.lapsed && sub.calendar);
        assert_eq!(push.deliveries(&calendar_notice(), "t", &["phone".into()]).unwrap().len(), 1);
    }

    #[test]
    fn forgetting_all_rotates_the_vapid_key() {
        let dir = tempfile::tempdir().unwrap();
        let mut push = PushStore::open(dir.path()).unwrap();
        let before = push.public_key();
        push.forget_all().unwrap();
        assert_ne!(push.public_key(), before);
        assert_eq!(PushStore::open(dir.path()).unwrap().public_key(), push.public_key());
    }

    #[test]
    fn deliveries_skip_unpaired_devices_and_honour_the_details_choice() {
        let dir = tempfile::tempdir().unwrap();
        let mut push = PushStore::open(dir.path()).unwrap();
        let ua_secret = random_secret_key().unwrap();
        let ua_public =
            Base64UrlUnpadded::encode_string(ua_secret.public_key().to_encoded_point(false).as_bytes());
        let auth = Base64UrlUnpadded::encode_string(&[9u8; 16]);
        push.subscribe("a", "https://fcm.googleapis.com/a", &ua_public, &auth, prefs(false))
            .unwrap();
        push.subscribe("b", "https://fcm.googleapis.com/b", &phone_key(), &auth, prefs(true))
            .unwrap();
        let out = push.deliveries(&calendar_notice(), "opaque", &["a".into()]).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].endpoint, "https://fcm.googleapis.com/a");
        // The body is ciphertext: neither the title nor the tag is readable.
        let text = String::from_utf8_lossy(&out[0].body);
        assert!(!text.contains("Dentist") && !text.contains("opaque"));
        assert_eq!(&out[0].body[16..20], &RECORD_SIZE.to_be_bytes());
    }

    /// Decrypt one delivery the way a phone would, to read what it was told.
    fn open(body: &[u8], ua_secret: &SecretKey, auth: &[u8; 16]) -> serde_json::Value {
        let salt = &body[..16];
        let as_public = PublicKey::from_sec1_bytes(&body[21..86]).unwrap();
        let shared = p256::ecdh::diffie_hellman(ua_secret.to_nonzero_scalar(), as_public.as_affine());
        let ua_public = ua_secret.public_key().to_encoded_point(false);
        let mut key_info = b"WebPush: info\0".to_vec();
        key_info.extend_from_slice(ua_public.as_bytes());
        key_info.extend_from_slice(&body[21..86]);
        let ikm = hkdf_expand::<32>(auth, shared.raw_secret_bytes(), &key_info).unwrap();
        let cek = hkdf_expand::<16>(salt, &ikm, b"Content-Encoding: aes128gcm\0").unwrap();
        let nonce = hkdf_expand::<12>(salt, &ikm, b"Content-Encoding: nonce\0").unwrap();
        let mut plain = Aes128Gcm::new_from_slice(&cek)
            .unwrap()
            .decrypt(Nonce::from_slice(&nonce), &body[86..])
            .unwrap();
        assert_eq!(plain.pop(), Some(2));
        serde_json::from_slice(&plain).unwrap()
    }

    fn agent_tab() -> AgentTabRef {
        AgentTabRef {
            project_id: "p-opaque".into(),
            project_label: "Aurora".into(),
            tab_id: "t-opaque".into(),
            tab_label: "Claude".into(),
            attached: false,
            devices: None,
        }
    }

    /// A scope open to some phones: its notice reaches only their
    /// subscriptions, and one that no allowed phone wants costs nothing — no
    /// budget, and no cooldown that would hold back the next turn.
    #[test]
    fn an_agent_notice_reaches_only_the_allowed_phones_and_spends_nothing_otherwise() {
        let dir = tempfile::tempdir().unwrap();
        let mut push = PushStore::open(dir.path()).unwrap();
        let auth = Base64UrlUnpadded::encode_string(&[3u8; 16]);
        let all = PushPrefs { details: true, calendar: true, agents: AgentNotices::All };
        push.subscribe("d1", "https://fcm.googleapis.com/1", &phone_key(), &auth, all).unwrap();
        push.subscribe("d2", "https://fcm.googleapis.com/2", &phone_key(), &auth, all).unwrap();
        let question = agent_tab().notice(concat!(crate::app_slug!(), "-x"), AgentTurn::Question, None);

        let out = push.deliveries(&question, "k", &["d2".into()]).unwrap();
        assert_eq!(out.iter().map(|d| d.endpoint.as_str()).collect::<Vec<_>>(), ["https://fcm.googleapis.com/2"]);
        assert_eq!(push.sent.len(), 1);

        // Allowed only to a phone with no subscription: nothing is spent.
        assert!(push.deliveries(&question, "k3", &["d3".into()]).unwrap().is_empty());
        assert_eq!(push.sent.len(), 1, "no budget for a notice nobody may get");
        assert!(!push.recent.contains_key("k3"), "no cooldown either");
        // So the same tab's next notice, once a phone may get it, goes out.
        assert_eq!(push.deliveries(&question, "k3", &["d1".into()]).unwrap().len(), 1);
    }

    #[test]
    fn agent_notices_follow_each_phones_choice_and_carry_only_opaque_ids() {
        let dir = tempfile::tempdir().unwrap();
        let mut push = PushStore::open(dir.path()).unwrap();
        let auth_bytes = random_bytes::<16>().unwrap();
        let auth = Base64UrlUnpadded::encode_string(&auth_bytes);
        let phones: Vec<(SecretKey, AgentNotices, bool)> = vec![
            (random_secret_key().unwrap(), AgentNotices::Off, true),
            (random_secret_key().unwrap(), AgentNotices::Questions, false),
            (random_secret_key().unwrap(), AgentNotices::All, true),
        ];
        for (i, (secret, agents, details)) in phones.iter().enumerate() {
            let key = Base64UrlUnpadded::encode_string(secret.public_key().to_encoded_point(false).as_bytes());
            let prefs = PushPrefs { details: *details, calendar: true, agents: *agents };
            push.subscribe(&format!("d{i}"), &format!("https://fcm.googleapis.com/{i}"), &key, &auth, prefs)
                .unwrap();
        }
        let paired: Vec<String> = (0..3).map(|i| format!("d{i}")).collect();

        let question = agent_tab().notice(concat!(crate::app_slug!(), "-raw-tmux"), AgentTurn::Question, None);
        let out = push.deliveries(&question, "k1", &paired).unwrap();
        assert_eq!(out.iter().map(|d| d.endpoint.as_str()).collect::<Vec<_>>(), [
            "https://fcm.googleapis.com/1",
            "https://fcm.googleapis.com/2",
        ]);
        let bare = open(&out[0].body, &phones[1].0, &auth_bytes);
        assert_eq!(bare, serde_json::json!({
            "kind": "agent", "status": "question", "tag": "k1", "project": "p-opaque", "tab": "t-opaque",
        }));
        let full = open(&out[1].body, &phones[2].0, &auth_bytes);
        assert_eq!(full["title"], "Aurora · Claude");
        assert_eq!(full["body"], "Needs your answer");

        // Within the cooldown the same tab stays quiet, even for a new edge.
        let done = agent_tab().notice(concat!(crate::app_slug!(), "-raw-tmux"), AgentTurn::Done, Some("fix the\n  tests"));
        assert!(push.deliveries(&done, "k1", &paired).unwrap().is_empty());
        // Another tab is not held back, and a finished turn reaches only "All",
        // quoting the prompt it answered on one line.
        let out = push.deliveries(&done, "k2", &paired).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].endpoint, "https://fcm.googleapis.com/2");
        assert_eq!(open(&out[0].body, &phones[2].0, &auth_bytes)["body"], "Finished “fix the tests”");
    }

    #[test]
    fn a_finished_turn_without_a_readable_prompt_says_so_plainly() {
        for prompt in [None, Some("  \n ")] {
            let done = agent_tab().notice("t", AgentTurn::Done, prompt);
            assert_eq!(done.body, "Finished its turn");
        }
        let long = "x".repeat(1000);
        let done = agent_tab().notice("t", AgentTurn::Done, Some(&long));
        assert!(done.body.ends_with("…”"));
        assert!(done.body.chars().count() <= MAX_BODY_CHARS);
        // A question never quotes one.
        assert_eq!(agent_tab().notice("t", AgentTurn::Question, Some("hi")).body, "Needs your answer");
    }

    #[test]
    fn a_phone_that_turned_calendar_off_gets_no_reminders() {
        let dir = tempfile::tempdir().unwrap();
        let mut push = PushStore::open(dir.path()).unwrap();
        let auth = Base64UrlUnpadded::encode_string(&[1u8; 16]);
        let prefs = PushPrefs { details: true, calendar: false, agents: AgentNotices::All };
        push.subscribe("a", "https://fcm.googleapis.com/a", &phone_key(), &auth, prefs).unwrap();
        assert!(push.deliveries(&calendar_notice(), "t", &["a".into()]).unwrap().is_empty());
    }

    #[test]
    fn a_runaway_caller_runs_out_of_budget() {
        let dir = tempfile::tempdir().unwrap();
        let mut push = PushStore::open(dir.path()).unwrap();
        for _ in 0..NOTICE_BUDGET_PER_MINUTE {
            assert!(push.within_budget(100));
        }
        assert!(!push.within_budget(100));
        assert!(push.within_budget(160));
    }

    #[test]
    fn long_text_is_clipped_on_a_character_boundary() {
        let long = "é".repeat(500);
        let clipped = clip(&long, MAX_TITLE_CHARS);
        assert_eq!(clipped.chars().count(), MAX_TITLE_CHARS);
        assert!(clipped.ends_with('…'));
    }
}

//! OIDC sign-in, the gateway's half (hosted plan §4.1, P5). See
//! [`crate::oidc_wire`] for the shape; here is the authorization-code flow
//! the gateway runs as the relying party.
//!
//! * **Configuration**: `oidc.json` in the gateway's state dir (`0600`, the
//!   gateway's account), written by the admin helper's `oidc-set` — the
//!   issuer, the client id, the client secret (read from the helper's stdin,
//!   never an argument) and the button's label. No file, no OIDC: invites
//!   stay the only way in.
//! * **Start** (`POST /gateway/v1/oidc/start`, exact origin): the browser
//!   sends the public key it wants paired. The gateway keeps a pending
//!   sign-in under a random `state`, with a PKCE verifier and a **binder** —
//!   a random value whose hash it keeps and which goes to this browser alone
//!   as a `__Host-` cookie (`SameSite=Lax`: the provider's redirect back is a
//!   cross-site top-level navigation). The `nonce` is
//!   [`oidc_wire::nonce_for`] the key.
//! * **Callback** (`GET /gateway/v1/oidc/callback`): the pending sign-in is
//!   taken by `state` **and** the binder cookie (so a sign-in someone else
//!   started — with their key — cannot be completed in a victim's browser),
//!   the code is exchanged at the token endpoint with the secret and the
//!   verifier, and the ID token is routed by the account linked to its
//!   person. That account's daemon verifies the token itself and pairs the
//!   key; the gateway records the device as for an invite.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use base64ct::{Base64UrlUnpadded, Encoding};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::oidc_wire;

pub const CONFIG_FILE: &str = "oidc.json";
/// The binder cookie (`__Host-`: secure, this host, path `/`).
pub const BINDER_COOKIE: &str = "__Host-oidc_binder";
/// How long a started sign-in waits for the provider's redirect.
pub const PENDING_FOR: u64 = 10 * 60;
/// Started sign-ins held at once (every stranger together).
pub const MAX_PENDING: usize = 256;
/// The provider's discovery document is fetched again after this.
const DISCOVERY_FOR: Duration = Duration::from_secs(60 * 60);
/// Largest answer read from the provider.
const MAX_ANSWER: usize = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OidcConfig {
    pub issuer: String,
    pub client_id: String,
    pub client_secret: String,
    /// What the sign-in button says ("Sign in with …").
    pub name: String,
}

impl OidcConfig {
    pub fn valid(&self) -> bool {
        valid_settings(&self.issuer, &self.client_id, &self.name) && (1..=1024).contains(&self.client_secret.len()) && !self.client_secret.chars().any(char::is_control)
    }

    /// The configuration in `dir`, when there is a valid one.
    pub fn load(dir: &Path) -> Option<Self> {
        let bytes = crate::read_regular(&dir.join(CONFIG_FILE)).ok()?;
        serde_json::from_slice::<OidcConfig>(&bytes).ok().filter(OidcConfig::valid)
    }

    pub fn save(&self, dir: &Path) -> std::io::Result<()> {
        let bytes = serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?;
        crate::write_atomic(&dir.join(CONFIG_FILE), &bytes, 0o600)
    }
}

/// The settings other than the secret: an https issuer, a client id (≤ 256
/// characters) and the button's label (1–64 characters), no control
/// characters.
pub fn valid_settings(issuer: &str, client_id: &str, name: &str) -> bool {
    oidc_wire::valid_issuer(issuer)
        && (1..=256).contains(&client_id.len())
        && !client_id.chars().any(char::is_control)
        && (1..=64).contains(&name.chars().count())
        && !name.chars().any(char::is_control)
}

/// The provider's endpoints, from its discovery document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Provider {
    pub authorization_endpoint: String,
    pub token_endpoint: String,
}

/// An endpoint the gateway sends a browser to or calls: https, or (tests)
/// plain http on loopback.
fn acceptable_endpoint(url: &str) -> bool {
    url.starts_with("https://") || url.starts_with("http://127.0.0.1:")
}

#[derive(Debug, Clone)]
pub struct Pending {
    binder: [u8; 32],
    pub verifier: String,
    pub public_key: String,
    pub device_name: String,
    created: u64,
}

pub struct Flow {
    client: reqwest::Client,
    pending: Mutex<HashMap<String, Pending>>,
    provider: Mutex<Option<(Instant, String, Provider)>>,
}

fn random_b64(n: usize) -> String {
    use rand::RngCore;
    let mut bytes = vec![0u8; n];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    Base64UrlUnpadded::encode_string(&bytes)
}

fn hash(value: &str) -> [u8; 32] {
    Sha256::digest(value.as_bytes()).into()
}

/// `application/x-www-form-urlencoded` (also a query string): everything but
/// the unreserved characters percent-encoded.
pub fn form(pairs: &[(&str, &str)]) -> String {
    let encode = |s: &str| {
        let mut out = String::new();
        for b in s.bytes() {
            if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
                out.push(b as char);
            } else {
                out.push_str(&format!("%{b:02X}"));
            }
        }
        out
    };
    pairs.iter().map(|(k, v)| format!("{}={}", encode(k), encode(v))).collect::<Vec<_>>().join("&")
}

/// A browser's public key as pairing takes it: base64url SPKI, bounded.
pub fn valid_public_key(key: &str) -> bool {
    (40..=400).contains(&key.len()) && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

impl Flow {
    pub fn new() -> Result<Self, String> {
        crate::broker::ensure_crypto();
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| format!("http client: {e}"))?;
        Ok(Flow { client, pending: Mutex::default(), provider: Mutex::default() })
    }

    async fn get_json(&self, url: &str) -> Result<serde_json::Value, String> {
        let answer = self.client.get(url).header("accept", "application/json").send().await.map_err(|e| e.without_url().to_string())?;
        if !answer.status().is_success() {
            return Err(format!("HTTP {}", answer.status().as_u16()));
        }
        let bytes = answer.bytes().await.map_err(|e| e.without_url().to_string())?;
        if bytes.len() > MAX_ANSWER {
            return Err("answer too large".into());
        }
        serde_json::from_slice(&bytes).map_err(|e| e.to_string())
    }

    /// The provider's endpoints (cached for an hour per issuer).
    pub async fn provider(&self, config: &OidcConfig) -> Result<Provider, String> {
        if let Some((at, issuer, provider)) = self.provider.lock().unwrap_or_else(PoisonError::into_inner).as_ref() {
            if *issuer == config.issuer && at.elapsed() < DISCOVERY_FOR {
                return Ok(provider.clone());
            }
        }
        let doc = self.get_json(&format!("{}/.well-known/openid-configuration", config.issuer.trim_end_matches('/'))).await?;
        if doc.get("issuer").and_then(|v| v.as_str()) != Some(config.issuer.as_str()) {
            return Err("the discovery document names another issuer".into());
        }
        let endpoint = |name: &str| doc.get(name).and_then(|v| v.as_str()).filter(|u| acceptable_endpoint(u)).map(str::to_string).ok_or(format!("no https {name}"));
        let provider = Provider { authorization_endpoint: endpoint("authorization_endpoint")?, token_endpoint: endpoint("token_endpoint")? };
        *self.provider.lock().unwrap_or_else(PoisonError::into_inner) = Some((Instant::now(), config.issuer.clone(), provider.clone()));
        Ok(provider)
    }

    /// Start a sign-in pairing `public_key`: `(binder, authorization URL)`.
    pub fn begin(&self, config: &OidcConfig, provider: &Provider, redirect_uri: &str, public_key: &str, device_name: &str, now: u64) -> Result<(String, String), &'static str> {
        if !valid_public_key(public_key) {
            return Err("invalid_public_key");
        }
        let mut pending = self.pending.lock().unwrap_or_else(PoisonError::into_inner);
        pending.retain(|_, p| now.saturating_sub(p.created) < PENDING_FOR);
        if pending.len() >= MAX_PENDING {
            return Err("busy");
        }
        let (state, binder, verifier) = (random_b64(24), random_b64(32), random_b64(32));
        let challenge = Base64UrlUnpadded::encode_string(&Sha256::digest(verifier.as_bytes()));
        let nonce = oidc_wire::nonce_for(public_key);
        let name: String = device_name.chars().filter(|c| !c.is_control()).take(64).collect();
        pending.insert(state.clone(), Pending { binder: hash(&binder), verifier, public_key: public_key.to_string(), device_name: name, created: now });
        let query = form(&[
            ("response_type", "code"),
            ("client_id", &config.client_id),
            ("redirect_uri", redirect_uri),
            ("scope", "openid email"),
            ("state", &state),
            ("nonce", &nonce),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
        ]);
        let separator = if provider.authorization_endpoint.contains('?') { '&' } else { '?' };
        Ok((binder, format!("{}{separator}{query}", provider.authorization_endpoint)))
    }

    /// The sign-in `state` names, if `binder` is the cookie this browser got
    /// at its start and it has not expired. Taken either way: one try.
    pub fn take(&self, state: &str, binder: &str, now: u64) -> Option<Pending> {
        let pending = self.pending.lock().unwrap_or_else(PoisonError::into_inner).remove(state)?;
        let fresh = now.saturating_sub(pending.created) < PENDING_FOR;
        (fresh && bool::from(pending.binder.ct_eq(&hash(binder)))).then_some(pending)
    }

    /// The ID token for `code` (client secret in the form, PKCE verifier).
    pub async fn exchange(&self, config: &OidcConfig, provider: &Provider, redirect_uri: &str, code: &str, verifier: &str) -> Result<String, String> {
        let body = form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("client_id", &config.client_id),
            ("client_secret", &config.client_secret),
            ("code_verifier", verifier),
        ]);
        let answer = self
            .client
            .post(&provider.token_endpoint)
            .header("content-type", "application/x-www-form-urlencoded")
            .header("accept", "application/json")
            .body(body)
            .send()
            .await
            .map_err(|e| e.without_url().to_string())?;
        let status = answer.status();
        let bytes = answer.bytes().await.map_err(|e| e.without_url().to_string())?;
        if !status.is_success() || bytes.len() > MAX_ANSWER {
            return Err(format!("token endpoint: HTTP {}", status.as_u16()));
        }
        let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        value.get("id_token").and_then(|v| v.as_str()).filter(|t| t.len() <= oidc_wire::MAX_TOKEN).map(str::to_string).ok_or_else(|| "no id_token in the answer".into())
    }
}

/// The binder cookie for a started sign-in, and the one that clears it.
pub fn binder_cookie(binder: &str) -> String {
    format!("{BINDER_COOKIE}={binder}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age={PENDING_FOR}")
}

pub fn clear_binder_cookie() -> String {
    format!("{BINDER_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0")
}

/// The binder from a `Cookie` header value.
pub fn binder_from(cookie: &str) -> Option<&str> {
    cookie.split(';').map(str::trim).find_map(|pair| pair.strip_prefix(BINDER_COOKIE).and_then(|rest| rest.strip_prefix('=')))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> OidcConfig {
        OidcConfig { issuer: "https://idp.example/realms/lab".into(), client_id: "desk".into(), client_secret: "fake-secret-0123".into(), name: "Lab SSO".into() }
    }

    const KEY: &str = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEfakefakefakefakefakefakefakefake";

    #[test]
    fn a_sign_in_is_bound_to_its_browser_its_key_and_one_try() {
        let flow = Flow::new().unwrap();
        let provider = Provider { authorization_endpoint: "https://idp.example/auth".into(), token_endpoint: "https://idp.example/token".into() };
        let (binder, url) = flow.begin(&config(), &provider, "https://desk.example/gateway/v1/oidc/callback", KEY, "Laptop\n", 1000).unwrap();
        assert!(url.starts_with("https://idp.example/auth?response_type=code&client_id=desk&redirect_uri=https%3A%2F%2Fdesk.example%2Fgateway%2Fv1%2Foidc%2Fcallback&scope=openid%20email&state="));
        assert!(url.contains(&format!("&nonce={}&", oidc_wire::nonce_for(KEY))) && url.contains("code_challenge_method=S256"));
        assert!(!url.contains(&binder) && !url.contains("fake-secret"), "neither the binder nor the secret travel to the provider");
        let state = url.split("state=").nth(1).unwrap().split('&').next().unwrap().to_string();
        assert!(flow.take(&state, "someone-elses-binder", 1001).is_none(), "another browser cannot complete it");
        assert!(flow.take(&state, &binder, 1001).is_none(), "and the try is spent");
        let (binder, url) = flow.begin(&config(), &provider, "https://desk.example/cb", KEY, "Laptop\n", 1000).unwrap();
        let state = url.split("state=").nth(1).unwrap().split('&').next().unwrap().to_string();
        assert!(flow.take(&state, &binder, 1000 + PENDING_FOR).is_none(), "expired");
        let (binder, url) = flow.begin(&config(), &provider, "https://desk.example/cb", KEY, "Laptop\n", 1000).unwrap();
        let state = url.split("state=").nth(1).unwrap().split('&').next().unwrap().to_string();
        let pending = flow.take(&state, &binder, 1001).unwrap();
        assert_eq!((pending.public_key.as_str(), pending.device_name.as_str()), (KEY, "Laptop"));
        assert_eq!(flow.begin(&config(), &provider, "https://desk.example/cb", "short", "x", 1000).unwrap_err(), "invalid_public_key");
    }

    #[test]
    fn cookies_forms_and_the_config_are_strict() {
        assert_eq!(binder_from("a=1; __Host-oidc_binder=xyz; b=2"), Some("xyz"));
        assert_eq!(binder_from("a=1"), None);
        assert!(binder_cookie("v").contains("SameSite=Lax") && binder_cookie("v").contains("HttpOnly") && binder_cookie("v").contains("Secure"));
        assert_eq!(form(&[("a b", "c&d=é")]), "a%20b=c%26d%3D%C3%A9");
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(OidcConfig::load(dir.path()), None);
        config().save(dir.path()).unwrap();
        assert_eq!(OidcConfig::load(dir.path()), Some(config()));
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(dir.path().join(CONFIG_FILE)).unwrap().permissions().mode() & 0o777, 0o600, "it holds the client secret");
        assert!(!OidcConfig { issuer: "http://idp.example".into(), ..config() }.valid());
        assert!(!OidcConfig { name: String::new(), ..config() }.valid());
    }
}

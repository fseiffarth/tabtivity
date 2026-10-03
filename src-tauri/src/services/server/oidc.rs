//! OIDC sign-in, the daemon's half (hosted plan §4.1, P5): the account's own
//! daemon decides whether an identity provider's ID token may pair a device
//! (`oidc_wire` has the shape). The gateway only routed the token here.
//!
//! * **The binding** (`<control dir>/oidc.json`, `0600`) is the admin
//!   helper's, written by this account's own uid (`--write-oidc-binding`,
//!   JSON on stdin; empty stdin removes it): the provider's issuer, the
//!   client id, and which person (`sub`, or a verified `email`) is this
//!   account. No binding, no OIDC pairing — invites keep working.
//! * **The token** is checked here in full: a compact JWS signed by one of
//!   the issuer's published keys (RS256 or ES256 only — never `none`, never
//!   an HMAC the client secret could forge), fetched from the issuer's
//!   discovery document over HTTPS and cached for an hour (once more when a
//!   key id is unknown); then [`oidc_wire::check_claims`] — issuer, audience,
//!   expiry, age, the nonce bound to the very key being paired, the person.
//! * **Once**: a token's nonce is remembered until it could no longer pass
//!   the age check, so the same token pairs at most one device.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64ct::{Base64UrlUnpadded, Encoding};
use serde::Deserialize;

use super::oidc_wire::{self, Binding};

/// How long the issuer's keys are trusted before they are fetched again.
const KEYS_FOR: Duration = Duration::from_secs(60 * 60);
/// An unknown key id fetches the keys again at most this often.
const REFETCH_EVERY: Duration = Duration::from_secs(60);
const MAX_ANSWER: usize = 512 * 1024;

pub fn binding_path(control_dir: &Path) -> PathBuf {
    control_dir.join(oidc_wire::BINDING_FILE)
}

/// This account's binding, when the administrator linked one.
pub fn binding_in(control_dir: &Path) -> Option<Binding> {
    let bytes = std::fs::read(binding_path(control_dir)).ok()?;
    serde_json::from_slice::<Binding>(&bytes).ok().filter(|b| oidc_wire::valid_issuer(&b.issuer) && b.link.valid() && !b.client_id.is_empty())
}

/// `--write-oidc-binding` (JSON on stdin; empty removes): the admin helper's
/// link, written by this account's own uid.
pub fn write_binding(state_dir: &Path, input: &str) -> Result<(), String> {
    let control_dir = state_dir.join("mobile-control");
    let path = binding_path(&control_dir);
    if input.trim().is_empty() {
        return match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("{}: {e}", path.display())),
            _ => Ok(()),
        };
    }
    let binding: Binding = serde_json::from_str(input.trim()).map_err(|e| format!("binding: {e}"))?;
    if !oidc_wire::valid_issuer(&binding.issuer) || !binding.link.valid() || binding.client_id.is_empty() {
        return Err("binding: not a valid issuer, client id or identity".into());
    }
    crate::services::agent_home::create_private_dir(&control_dir).map_err(|e| format!("{}: {e}", control_dir.display()))?;
    crate::services::mobile_control::store::write_json_atomic(&path, &binding, 0o600)
}

/// One published key of the issuer.
#[derive(Debug, Clone, Deserialize)]
pub struct Jwk {
    pub kty: String,
    #[serde(default)]
    pub kid: Option<String>,
    #[serde(default)]
    pub alg: Option<String>,
    #[serde(default, rename = "use")]
    pub use_: Option<String>,
    #[serde(default)]
    pub n: Option<String>,
    #[serde(default)]
    pub e: Option<String>,
    #[serde(default)]
    pub crv: Option<String>,
    #[serde(default)]
    pub x: Option<String>,
    #[serde(default)]
    pub y: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Jwks {
    #[serde(default)]
    pub keys: Vec<Jwk>,
}

#[derive(Deserialize)]
struct Header {
    alg: String,
    #[serde(default)]
    kid: Option<String>,
}

/// The JWS header of `token` (its `alg` and `kid`).
fn header_of(token: &str) -> Option<(String, Option<String>)> {
    let header = token.split('.').next()?;
    let bytes = Base64UrlUnpadded::decode_vec(header).ok()?;
    let header: Header = serde_json::from_slice(&bytes).ok()?;
    Some((header.alg, header.kid))
}

fn verify_with(key: &Jwk, alg: &str, message: &[u8], signature: &[u8]) -> bool {
    if key.use_.as_deref().is_some_and(|u| u != "sig") || key.alg.as_deref().is_some_and(|a| a != alg) {
        return false;
    }
    let decode = |v: &Option<String>| v.as_deref().and_then(|s| Base64UrlUnpadded::decode_vec(s).ok());
    match (alg, key.kty.as_str()) {
        ("RS256", "RSA") => {
            let (Some(n), Some(e)) = (decode(&key.n), decode(&key.e)) else { return false };
            let start = n.iter().position(|&b| b != 0).unwrap_or(n.len());
            let components = ring::signature::RsaPublicKeyComponents { n: &n[start..], e: &e[..] };
            components.verify(&ring::signature::RSA_PKCS1_2048_8192_SHA256, message, signature).is_ok()
        }
        ("ES256", "EC") if key.crv.as_deref() == Some("P-256") => {
            use p256::ecdsa::signature::Verifier;
            let (Some(x), Some(y)) = (decode(&key.x), decode(&key.y)) else { return false };
            if x.len() != 32 || y.len() != 32 {
                return false;
            }
            let point = p256::EncodedPoint::from_affine_coordinates(x.as_slice().into(), y.as_slice().into(), false);
            let (Ok(verifying), Ok(signature)) = (p256::ecdsa::VerifyingKey::from_encoded_point(&point), p256::ecdsa::Signature::from_slice(signature)) else {
                return false;
            };
            verifying.verify(message, &signature).is_ok()
        }
        _ => false,
    }
}

/// The claims of `token` when one of `jwks`' keys signed it (RS256/ES256;
/// the key named by `kid` when there is one). `Err("unknown-key")` when no
/// key carries that id — worth fetching the keys again.
pub fn verified_claims(token: &str, jwks: &Jwks) -> Result<serde_json::Value, &'static str> {
    if token.len() > oidc_wire::MAX_TOKEN {
        return Err("token");
    }
    let (alg, kid) = header_of(token).ok_or("token")?;
    if !matches!(alg.as_str(), "RS256" | "ES256") {
        return Err("algorithm");
    }
    let (message, signature) = token.rsplit_once('.').ok_or("token")?;
    let signature = Base64UrlUnpadded::decode_vec(signature).map_err(|_| "token")?;
    let candidates: Vec<&Jwk> = jwks.keys.iter().filter(|k| kid.is_none() || k.kid == kid).collect();
    if candidates.is_empty() {
        return Err("unknown-key");
    }
    if !candidates.iter().any(|key| verify_with(key, &alg, message.as_bytes(), &signature)) {
        return Err("signature");
    }
    oidc_wire::claims_unverified(token).ok_or("token")
}

/// Signature and every claim: `Ok` when `token` may pair `public_key` for
/// this account (`binding`) at `now`.
pub fn check_token(token: &str, jwks: &Jwks, binding: &Binding, public_key: &str, now: u64) -> Result<(), &'static str> {
    let claims = verified_claims(token, jwks)?;
    oidc_wire::check_claims(&claims, binding, &oidc_wire::nonce_for(public_key), now)
}

// ── The issuer's keys, fetched ────────────────────────────────────────────

struct KeyCache {
    issuer: String,
    fetched: Instant,
    jwks: Jwks,
}

static KEYS: Mutex<Option<KeyCache>> = Mutex::new(None);
/// Nonces already used, with when they may be forgotten.
static USED: Mutex<Option<HashMap<String, u64>>> = Mutex::new(None);

async fn get_json(client: &reqwest::Client, url: &str) -> Result<serde_json::Value, String> {
    let answer = client.get(url).header("accept", "application/json").send().await.map_err(|e| e.without_url().to_string())?;
    if !answer.status().is_success() {
        return Err(format!("HTTP {}", answer.status().as_u16()));
    }
    let bytes = answer.bytes().await.map_err(|e| e.without_url().to_string())?;
    if bytes.len() > MAX_ANSWER {
        return Err("answer too large".into());
    }
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

/// The issuer's published keys, from its discovery document's `jwks_uri`
/// (HTTPS only, the same issuer named inside).
async fn fetch_jwks(issuer: &str) -> Result<Jwks, String> {
    crate::services::mail_engine::install_crypto_provider();
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let doc = get_json(&client, &format!("{}/.well-known/openid-configuration", issuer.trim_end_matches('/'))).await?;
    if doc.get("issuer").and_then(|v| v.as_str()) != Some(issuer) {
        return Err("the discovery document names another issuer".into());
    }
    let uri = doc.get("jwks_uri").and_then(|v| v.as_str()).filter(|u| u.starts_with("https://")).ok_or("no https jwks_uri")?;
    serde_json::from_value(get_json(&client, uri).await?).map_err(|e| e.to_string())
}

async fn jwks_for(issuer: &str, again: bool) -> Result<Jwks, String> {
    {
        let cache = KEYS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(c) = cache.as_ref().filter(|c| c.issuer == issuer) {
            let fresh = c.fetched.elapsed() < KEYS_FOR;
            let may_refetch = c.fetched.elapsed() >= REFETCH_EVERY;
            if fresh && !(again && may_refetch) {
                return Ok(c.jwks.clone());
            }
        }
    }
    let jwks = fetch_jwks(issuer).await?;
    *KEYS.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(KeyCache { issuer: issuer.into(), fetched: Instant::now(), jwks: jwks.clone() });
    Ok(jwks)
}

/// Remember `nonce` as spent; `false` when it already was.
fn spend(nonce: &str, now: u64) -> bool {
    let mut used = USED.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let used = used.get_or_insert_with(HashMap::new);
    used.retain(|_, until| *until > now);
    if used.contains_key(nonce) {
        return false;
    }
    used.insert(nonce.to_string(), now + oidc_wire::MAX_TOKEN_AGE + 2 * oidc_wire::SKEW);
    true
}

/// May `token` pair `public_key` for this account? A server's daemon only;
/// the reason is a fixed word, never the token's content.
pub async fn check(control_dir: &Path, token: &str, public_key: &str) -> Result<(), String> {
    if !super::is_server() {
        return Err("not-a-server".into());
    }
    let binding = binding_in(control_dir).ok_or("no-binding")?;
    let now = crate::services::mobile_control::auth::now();
    let jwks = jwks_for(&binding.issuer, false).await?;
    let result = match check_token(token, &jwks, &binding, public_key, now) {
        Err("unknown-key") => check_token(token, &jwks_for(&binding.issuer, true).await?, &binding, public_key, now),
        other => other,
    };
    result.map_err(str::to_string)?;
    if !spend(&oidc_wire::nonce_for(public_key), now) {
        return Err("replayed".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::oidc_wire::Link;

    /// A fixed RS256 vector: signed once with a throwaway key whose private
    /// half was discarded; only its public modulus is here.
    const RSA_HEADER: &str = r#"{"alg":"RS256","kid":"test-rsa","typ":"JWT"}"#;
    const RSA_CLAIMS: &str = r#"{"iss":"https://idp.example/realms/lab","aud":"desk","sub":"u-1","nonce":"BoxYobzEI-CoyopCFoJ5uFkrRcKKSe3zg6w-m-hYqb8","iat":1800000000,"exp":1800000600}"#;
    const RSA_SIGNATURE: &str = "Xihjf7vxZwdmuKf7rjOI8s4zd5mwCJ4SlPzYfZlzZBRh18v1gCpQPKq_uTqw0hHPXDdJvq7F30dvpZtP9eCnfulvNOkRIYwTvWBHYOjlFReRCwnYoVy3RPpIA0AvhGRMM5Q7cK3UfZ7thSHi1IbwTLc_Kt1H3UT8fWln6sD3nwAI7mzAILQaWyIVDer2ETdmbAbQgnEZFpr0jm1owh8s4_vOKIikoEvRqWmZmR1vy4bub1LVcSUths699eZrG8Ik_kpDye_rCjdYoqV_67IbtwPPAtcprG5EaGO7rapod24hh_WrMfG4mjI5yjsAi97QFcHTaNFjdvL4nxwErWYvxQ";

    /// The vector as a compact token (built here: the parts are what was signed).
    fn rsa_token() -> String {
        format!("{}.{}.{RSA_SIGNATURE}", Base64UrlUnpadded::encode_string(RSA_HEADER.as_bytes()), Base64UrlUnpadded::encode_string(RSA_CLAIMS.as_bytes()))
    }
    const RSA_N: &str = "n89W0wcPxy9v75jvwAcHPc6Dc2ykmrQygBY4IfNNQMwzvgqbZRRkTZyEpGqxMmy7_S4pl7VflI_jMfBVyWNg-g-h4w53_cE6S7sP4GPk-ycoe745sktCOTeaCu3OvbG7EZx1RZxt6gzQNomGakEiSJiwSEQ4xEetvE9OdOgFoW_TQB0vbEDLlKKPoHUCgfftBGwiYBcz4sx7KqxCvhJfsdeFwF-yZZa5oAadV9IQoDDdguc5Hvd8glslMiee8HEfiBlSOZmZY_3n9RHAWGrr_TblDVBI3CBwqjWqzwZR7HnuUhli8aJhu0xATn-VlV3a_a0bmD6KM7-UhHQLU1eo7w";
    /// The browser key the vector's nonce is bound to.
    const KEY: &str = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEfakefakefakefakefakefakefakefake";
    const NOW: u64 = 1_800_000_060;

    fn rsa_jwks() -> Jwks {
        serde_json::from_value(serde_json::json!({ "keys": [{ "kty": "RSA", "kid": "test-rsa", "use": "sig", "n": RSA_N, "e": "AQAB" }] })).unwrap()
    }

    fn binding() -> Binding {
        Binding { issuer: "https://idp.example/realms/lab".into(), client_id: "desk".into(), link: Link { claim: "sub".into(), value: "u-1".into() } }
    }

    #[test]
    fn an_rs256_token_pairs_only_its_own_key_for_the_linked_person() {
        assert_eq!(check_token(&rsa_token(), &rsa_jwks(), &binding(), KEY, NOW), Ok(()));
        assert_eq!(check_token(&rsa_token(), &rsa_jwks(), &binding(), "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEanotherkeyanotherkeyanotherkey", NOW), Err("nonce"));
        let bob = Binding { link: Link { claim: "sub".into(), value: "u-2".into() }, ..binding() };
        assert_eq!(check_token(&rsa_token(), &rsa_jwks(), &bob, KEY, NOW), Err("identity"));
        assert_eq!(check_token(&rsa_token(), &rsa_jwks(), &binding(), KEY, NOW + 3600), Err("expired"));
        // A changed payload breaks the signature.
        let token = rsa_token();
        let mut parts: Vec<String> = token.split('.').map(str::to_string).collect();
        let mut claims = oidc_wire::claims_unverified(&token).unwrap();
        claims["sub"] = "u-2".into();
        parts[1] = Base64UrlUnpadded::encode_string(claims.to_string().as_bytes());
        assert_eq!(check_token(&parts.join("."), &rsa_jwks(), &bob, KEY, NOW), Err("signature"));
        let other_key: Jwks = serde_json::from_value(serde_json::json!({ "keys": [{ "kty": "RSA", "kid": "other", "n": RSA_N, "e": "AQAB" }] })).unwrap();
        assert_eq!(check_token(&rsa_token(), &other_key, &binding(), KEY, NOW), Err("unknown-key"), "fetch the keys again");
        let wrong_alg: Jwks = serde_json::from_value(serde_json::json!({ "keys": [{ "kty": "RSA", "kid": "test-rsa", "alg": "RS512", "n": RSA_N, "e": "AQAB" }] })).unwrap();
        assert_eq!(check_token(&rsa_token(), &wrong_alg, &binding(), KEY, NOW), Err("signature"));
    }

    fn es256_token(signing: &p256::ecdsa::SigningKey, header: serde_json::Value, claims: serde_json::Value) -> String {
        use p256::ecdsa::signature::Signer;
        let message = format!("{}.{}", Base64UrlUnpadded::encode_string(header.to_string().as_bytes()), Base64UrlUnpadded::encode_string(claims.to_string().as_bytes()));
        let signature: p256::ecdsa::Signature = signing.sign(message.as_bytes());
        format!("{message}.{}", Base64UrlUnpadded::encode_string(&signature.to_bytes()))
    }

    #[test]
    fn es256_is_verified_and_none_or_hmac_never_are() {
        let signing = p256::ecdsa::SigningKey::random(&mut rand::rngs::OsRng);
        let point = signing.verifying_key().to_encoded_point(false);
        let jwks: Jwks = serde_json::from_value(serde_json::json!({ "keys": [{ "kty": "EC", "crv": "P-256", "kid": "ec1", "x": Base64UrlUnpadded::encode_string(point.x().unwrap()), "y": Base64UrlUnpadded::encode_string(point.y().unwrap()) }] })).unwrap();
        let claims = serde_json::json!({ "iss": "https://idp.example/realms/lab", "aud": ["desk"], "sub": "u-1", "nonce": oidc_wire::nonce_for(KEY), "iat": NOW, "exp": NOW + 60 });
        let token = es256_token(&signing, serde_json::json!({ "alg": "ES256", "kid": "ec1" }), claims.clone());
        assert_eq!(check_token(&token, &jwks, &binding(), KEY, NOW), Ok(()));
        let unsigned = format!("{}.{}.", Base64UrlUnpadded::encode_string(br#"{"alg":"none"}"#), Base64UrlUnpadded::encode_string(claims.to_string().as_bytes()));
        assert_eq!(check_token(&unsigned, &jwks, &binding(), KEY, NOW), Err("algorithm"));
        let hmac = es256_token(&signing, serde_json::json!({ "alg": "HS256", "kid": "ec1" }), claims);
        assert_eq!(check_token(&hmac, &jwks, &binding(), KEY, NOW), Err("algorithm"), "the client secret must never sign");
        assert_eq!(check_token("not-a-token", &jwks, &binding(), KEY, NOW), Err("token"));
    }

    #[test]
    fn a_nonce_is_spent_once_and_the_binding_file_round_trips() {
        assert!(spend("n-test-once", 100));
        assert!(!spend("n-test-once", 101), "the same token pairs one device");
        assert!(spend("n-test-once", 100 + oidc_wire::MAX_TOKEN_AGE + 2 * oidc_wire::SKEW + 1), "forgotten once it could not pass the age check");
        let dir = tempfile::tempdir().unwrap();
        let control = dir.path().join("mobile-control");
        assert!(binding_in(&control).is_none());
        write_binding(dir.path(), &serde_json::to_string(&binding()).unwrap()).unwrap();
        assert_eq!(binding_in(&control), Some(binding()));
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(binding_path(&control)).unwrap().permissions().mode() & 0o777, 0o600);
        assert!(write_binding(dir.path(), r#"{"issuer":"http://idp.example","client_id":"d","claim":"sub","value":"u"}"#).is_err());
        write_binding(dir.path(), "").unwrap();
        assert!(binding_in(&control).is_none());
    }
}

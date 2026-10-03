//! OIDC sign-in (hosted plan §4.1/§4.2, P5): what the gateway and a
//! per-user daemon must agree on, in one file both compile — the gateway's
//! crate as `app_gateway::oidc_wire`, the daemon's by `#[path]`
//! (`services::server::oidc_wire`). `std` + `serde` + `sha2` + `base64ct`
//! (both crates have them), no brand constants.
//!
//! The shape: an identity provider's sign-in **pairs a new device**, in
//! place of the administrator's invite code. The gateway runs the
//! authorization-code flow (it holds the client secret) and routes the ID
//! token by the account the administrator linked to that identity
//! ([`Link`], in the gateway's table); the account's **own daemon** then
//! checks the token itself — the provider's signature, issuer, audience,
//! expiry, its own copy of the link ([`Binding`], written by the admin helper
//! as that user), and a nonce bound to the very public key being paired
//! ([`nonce_for`]) — before it registers the device. So, as with invites,
//! the gateway routes and the daemon decides: a compromised gateway cannot
//! pair a device to an account without that account's own provider sign-in,
//! and a token minted for one browser's key pairs no other key.

#![allow(dead_code)]

use base64ct::{Base64UrlUnpadded, Encoding};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// The daemon's copy of its account's link, in its control dir.
pub const BINDING_FILE: &str = "oidc.json";
/// The longest ID token either side reads.
pub const MAX_TOKEN: usize = 16 * 1024;
/// An ID token older than this (by `iat`) does not pair.
pub const MAX_TOKEN_AGE: u64 = 10 * 60;
/// Clock skew allowed on `exp`/`iat`.
pub const SKEW: u64 = 120;

/// Which claim of the ID token names the account's person, and its value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Link {
    /// Always `sub`, the provider's stable id (user decision, final review:
    /// an `email` link trusted a provider's `email_verified`, a takeover
    /// path where the address is a mutable profile field). A stored link
    /// naming another claim is invalid and pairs nobody.
    pub claim: String,
    pub value: String,
}

impl Link {
    pub fn valid(&self) -> bool {
        self.claim == "sub" && !self.value.is_empty() && self.value.len() <= 256 && !self.value.chars().any(char::is_control)
    }
}

/// What the daemon checks a token against: the provider and client the
/// administrator configured, and this account's link.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Binding {
    pub issuer: String,
    pub client_id: String,
    #[serde(flatten)]
    pub link: Link,
}

/// An issuer the server accepts: `https://host[:port][/path]`, no query,
/// fragment or credentials.
pub fn valid_issuer(issuer: &str) -> bool {
    // Tests run a fake provider on plain loopback HTTP; a build never does.
    #[cfg(test)]
    if issuer.starts_with("http://127.0.0.1:") {
        return true;
    }
    let Some(rest) = issuer.strip_prefix("https://") else { return false };
    !rest.is_empty() && rest.len() < 512 && !rest.contains(['?', '#', '@', ' ']) && !rest.starts_with('/') && rest.chars().all(|c| c.is_ascii_graphic())
}

/// The `nonce` of a sign-in that pairs `public_key` (the browser's pairing
/// key, base64url SPKI): the gateway puts it in the authorization request,
/// the daemon recomputes it from the key it is asked to register.
pub fn nonce_for(public_key: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(b"oidc-pair-nonce\0");
    hash.update(public_key.as_bytes());
    Base64UrlUnpadded::encode_string(&hash.finalize())
}

/// The claims of a compact JWS, **unverified** (the gateway reads them only
/// to route a token it received from the provider's token endpoint over TLS;
/// the daemon verifies the signature before trusting any of them).
pub fn claims_unverified(token: &str) -> Option<serde_json::Value> {
    if token.len() > MAX_TOKEN {
        return None;
    }
    let mut parts = token.split('.');
    let (_, payload, _, None) = (parts.next()?, parts.next()?, parts.next()?, parts.next()) else { return None };
    let bytes = Base64UrlUnpadded::decode_vec(payload).ok()?;
    serde_json::from_slice(&bytes).ok().filter(serde_json::Value::is_object)
}

/// Does `claims` name `link`'s person? `sub`, exactly; nothing else links.
pub fn names(claims: &serde_json::Value, link: &Link) -> bool {
    link.claim == "sub" && claims.get("sub").and_then(|v| v.as_str()) == Some(link.value.as_str())
}

/// Every check of an ID token's claims but the signature: issuer, audience
/// (and `azp` when there are several), expiry and age, the nonce, the link.
pub fn check_claims(claims: &serde_json::Value, binding: &Binding, nonce: &str, now: u64) -> Result<(), &'static str> {
    if claims.get("iss").and_then(|v| v.as_str()) != Some(binding.issuer.as_str()) {
        return Err("issuer");
    }
    let audiences: Vec<&str> = match claims.get("aud") {
        Some(serde_json::Value::String(one)) => vec![one.as_str()],
        Some(serde_json::Value::Array(many)) => many.iter().filter_map(|v| v.as_str()).collect(),
        _ => Vec::new(),
    };
    if !audiences.contains(&binding.client_id.as_str()) {
        return Err("audience");
    }
    if audiences.len() > 1 && claims.get("azp").and_then(|v| v.as_str()) != Some(binding.client_id.as_str()) {
        return Err("audience");
    }
    let exp = claims.get("exp").and_then(|v| v.as_u64()).ok_or("expiry")?;
    if exp + SKEW < now {
        return Err("expired");
    }
    let iat = claims.get("iat").and_then(|v| v.as_u64()).ok_or("issued")?;
    if iat > now + SKEW || now.saturating_sub(iat) > MAX_TOKEN_AGE {
        return Err("issued");
    }
    if claims.get("nonce").and_then(|v| v.as_str()) != Some(nonce) {
        return Err("nonce");
    }
    if !names(claims, &binding.link) {
        return Err("identity");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn binding(claim: &str, value: &str) -> Binding {
        Binding { issuer: "https://idp.example/realms/lab".into(), client_id: "desk".into(), link: Link { claim: claim.into(), value: value.into() } }
    }

    fn claims(now: u64, nonce: &str) -> serde_json::Value {
        json!({ "iss": "https://idp.example/realms/lab", "aud": "desk", "exp": now + 300, "iat": now - 5, "nonce": nonce, "sub": "u-1", "email": "Alice@Example.invalid", "email_verified": true })
    }

    #[test]
    fn every_claim_is_checked_and_the_nonce_binds_the_key() {
        let now = 1_800_000_000;
        let nonce = nonce_for("KEY-A");
        assert_ne!(nonce, nonce_for("KEY-B"));
        let ok = claims(now, &nonce);
        assert_eq!(check_claims(&ok, &binding("sub", "u-1"), &nonce, now), Ok(()));
        assert_eq!(check_claims(&ok, &binding("email", "alice@example.invalid"), &nonce, now), Err("identity"), "links are by sub only, a verified email included");
        assert!(!Link { claim: "email".into(), value: "alice@example.invalid".into() }.valid());
        assert_eq!(check_claims(&ok, &binding("sub", "u-2"), &nonce, now), Err("identity"));
        assert_eq!(check_claims(&ok, &binding("sub", "u-1"), &nonce_for("KEY-B"), now), Err("nonce"), "a token for one key pairs no other");
        let tweak = |key: &str, value: serde_json::Value| {
            let mut c = ok.clone();
            c[key] = value;
            check_claims(&c, &binding("sub", "u-1"), &nonce, now)
        };
        assert_eq!(tweak("iss", json!("https://evil.example")), Err("issuer"));
        assert_eq!(tweak("aud", json!("other")), Err("audience"));
        assert_eq!(tweak("aud", json!(["other", "desk"])), Err("audience"), "several audiences need azp");
        assert_eq!(tweak("exp", json!(now - 600)), Err("expired"));
        assert_eq!(tweak("iat", json!(now - MAX_TOKEN_AGE - 1)), Err("issued"));
        assert_eq!(tweak("iat", json!(now + 600)), Err("issued"));
        let mut several = ok.clone();
        several["aud"] = json!(["desk", "other"]);
        several["azp"] = json!("desk");
        assert_eq!(check_claims(&several, &binding("sub", "u-1"), &nonce, now), Ok(()));
    }

    #[test]
    fn issuers_links_and_compact_tokens_are_strict() {
        assert!(valid_issuer("https://idp.example/realms/lab"));
        assert!(valid_issuer("https://accounts.example.com"));
        for bad in ["http://idp.example", "https://", "https://a@b", "https://idp.example/?x", "https://idp example"] {
            assert!(!valid_issuer(bad), "{bad}");
        }
        assert!(Link { claim: "sub".into(), value: "x".into() }.valid());
        assert!(!Link { claim: "name".into(), value: "x".into() }.valid());
        assert!(!Link { claim: "sub".into(), value: String::new() }.valid());
        let payload = Base64UrlUnpadded::encode_string(br#"{"sub":"u"}"#);
        assert_eq!(claims_unverified(&format!("h.{payload}.s")).unwrap()["sub"], "u");
        assert!(claims_unverified(&format!("h.{payload}")).is_none());
        assert!(claims_unverified(&format!("h.{payload}.s.x")).is_none());
        assert!(claims_unverified("h.!!.s").is_none());
    }
}

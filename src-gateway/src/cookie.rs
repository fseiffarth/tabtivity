//! The routing cookie (hosted plan §3.1, §4.2): which account and device a
//! browser's requests go to, `HMAC-SHA256`-signed by the gateway's key. It
//! grants nothing by itself — the daemon still checks its own session — and
//! it is re-checked against the account table on every request, so revoking a
//! device in the table stops its routing at once.
//!
//! Value: `v1.<user>.<device>.<expires>.<base64url(mac)>`; the MAC covers
//! everything before the last dot. Names and device ids carry no dot
//! (`wire::valid_account_name`, `wire::valid_device_id`).

use std::path::Path;

use base64ct::{Base64UrlUnpadded, Encoding};
use hmac::{Hmac, Mac};
use sha2::Sha256;

pub const KEY_FILE: &str = "routing.key";
/// The daemon's phone/browser session lasts 12 h (`host::login`); routing a
/// little longer never outlives it in effect.
pub const TTL: u64 = 13 * 60 * 60;

#[derive(Clone)]
pub struct RoutingKey([u8; 32]);

impl RoutingKey {
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    /// Read `<dir>/routing.key`, creating it (`0600`, 32 random bytes) on
    /// first start.
    pub fn load_or_create(dir: &Path) -> std::io::Result<Self> {
        let path = dir.join(KEY_FILE);
        match std::fs::read(&path) {
            Ok(bytes) if bytes.len() == 32 => {
                let mut key = [0u8; 32];
                key.copy_from_slice(&bytes);
                Ok(Self(key))
            }
            Ok(_) => Err(std::io::Error::other(format!("{}: not a 32-byte key", path.display()))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let mut key = [0u8; 32];
                rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut key);
                crate::write_atomic(&path, &key, 0o600)?;
                Ok(Self(key))
            }
            Err(e) => Err(e),
        }
    }

    fn mac(&self, body: &str) -> Hmac<Sha256> {
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&self.0).expect("HMAC takes any key length");
        mac.update(body.as_bytes());
        mac
    }

    pub fn mint(&self, user: &str, device: &str, expires_at: u64) -> String {
        let body = format!("v1.{user}.{device}.{expires_at}");
        let tag = self.mac(&body).finalize().into_bytes();
        format!("{body}.{}", Base64UrlUnpadded::encode_string(&tag))
    }

    /// `(user, device)` of a valid, unexpired value.
    pub fn verify(&self, value: &str, now: u64) -> Option<(String, String)> {
        let (body, tag) = value.rsplit_once('.')?;
        let tag = Base64UrlUnpadded::decode_vec(tag).ok()?;
        self.mac(body).verify_slice(&tag).ok()?;
        let mut parts = body.split('.');
        let (Some("v1"), Some(user), Some(device), Some(expires), None) = (parts.next(), parts.next(), parts.next(), parts.next(), parts.next()) else {
            return None;
        };
        let expires: u64 = expires.parse().ok()?;
        (expires > now && crate::wire::valid_account_name(user) && crate::wire::valid_device_id(device)).then(|| (user.to_string(), device.to_string()))
    }
}

/// `Set-Cookie` for a fresh routing cookie.
pub fn set_cookie(value: &str) -> String {
    format!("{}={value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age={TTL}", crate::brand::GATEWAY_COOKIE)
}

/// `Set-Cookie` that clears it.
pub fn clear_cookie() -> String {
    format!("{}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0", crate::brand::GATEWAY_COOKIE)
}

/// The routing cookie's value from a `Cookie` header, if present.
pub fn from_cookie_header(header: &str) -> Option<&str> {
    header.split(';').map(str::trim).find_map(|pair| pair.strip_prefix(crate::brand::GATEWAY_COOKIE)?.strip_prefix('='))
}

/// The `Cookie` header without the routing cookie, for the daemon (`None`
/// when nothing else is left).
pub fn without_routing_cookie(header: &str) -> Option<String> {
    let rest: Vec<&str> = header
        .split(';')
        .map(str::trim)
        .filter(|pair| !pair.is_empty() && pair.split_once('=').map(|(name, _)| name) != Some(crate::brand::GATEWAY_COOKIE))
        .collect();
    (!rest.is_empty()).then(|| rest.join("; "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cookie_verifies_only_unaltered_and_unexpired() {
        let key = RoutingKey::from_bytes([7; 32]);
        let value = key.mint("alice", "dev_alice_0001", 100);
        assert_eq!(key.verify(&value, 99), Some(("alice".into(), "dev_alice_0001".into())));
        assert_eq!(key.verify(&value, 100), None, "expired");
        assert_eq!(key.verify(&value.replace("alice", "bobby"), 50), None, "another user");
        assert_eq!(RoutingKey::from_bytes([8; 32]).verify(&value, 50), None, "another key");
        assert_eq!(key.verify("v1.alice.dev_alice_0001.100", 50), None, "no tag");
        assert_eq!(key.verify("", 50), None);
    }

    #[test]
    fn the_cookie_header_is_parsed_and_stripped() {
        let name = crate::brand::GATEWAY_COOKIE;
        let header = format!("a=1; {name}=v1.x; {}=tok", crate::brand::SESSION_COOKIE);
        assert_eq!(from_cookie_header(&header), Some("v1.x"));
        assert_eq!(without_routing_cookie(&header).unwrap(), format!("a=1; {}=tok", crate::brand::SESSION_COOKIE));
        assert_eq!(without_routing_cookie(&format!("{name}=v")), None);
        assert!(set_cookie("v").contains("HttpOnly") && set_cookie("v").contains("Secure") && set_cookie("v").starts_with("__Host-"));
    }

    #[test]
    fn the_key_file_is_created_once_and_private() {
        let dir = tempfile::tempdir().unwrap();
        let a = RoutingKey::load_or_create(dir.path()).unwrap();
        let b = RoutingKey::load_or_create(dir.path()).unwrap();
        assert_eq!(a.0, b.0);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(dir.path().join(KEY_FILE)).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }
}

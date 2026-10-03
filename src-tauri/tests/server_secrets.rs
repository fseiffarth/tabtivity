//! The device-released secrets key end to end on a daemon (hosted plan §6.8,
//! TODO #2350): a device pairs, enrols its ECDH key, sets the key up (signed
//! by its pairing key, not the cookie alone); mail and saved passwords are
//! sealed under it; a "reboot" (the hold flushed) locks both; the device's
//! unlock exchange over HTTP opens them again; revoking a device rotates the
//! key and the other device still opens everything.
//!
//! Its own test binary on purpose: it installs the process-wide vault, which
//! would turn every other test of the library into a server's.

#![cfg(unix)]

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use app_lib::services::mail_crypt::{self, Unlock};
use app_lib::services::mobile_control::auth;
use app_lib::services::remote_credentials;
use app_lib::services::server::vault::{self, KeyHold, MemoryHold, Vault};
use app_lib::services::server::{daemon, ServerConfig};
use base64ct::{Base64UrlUnpadded, Encoding};
use p256::ecdsa::signature::{Signer, Verifier};
use p256::ecdsa::{Signature, SigningKey, VerifyingKey};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::pkcs8::{DecodePublicKey, EncodePublicKey};
use p256::{PublicKey, SecretKey};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

const ORIGIN: &str = "https://desk.example.ts.net";

fn b64(bytes: &[u8]) -> String {
    Base64UrlUnpadded::encode_string(bytes)
}

fn unb64(text: &str) -> Vec<u8> {
    Base64UrlUnpadded::decode_vec(text).unwrap()
}

async fn raw(socket: &std::path::Path, method: &str, path: &str, cookie: Option<&str>, body: Option<&str>) -> (u16, Vec<(String, String)>, String) {
    let mut stream = UnixStream::connect(socket).await.expect("connect");
    let mut request = format!("{method} {path} HTTP/1.1\r\nHost: desk.example.ts.net\r\nOrigin: {ORIGIN}\r\nConnection: close\r\n");
    if let Some(cookie) = cookie {
        request.push_str(&format!("Cookie: {cookie}\r\n"));
    }
    let body = body.unwrap_or("");
    if method == "POST" {
        request.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", body.len()));
    }
    request.push_str("\r\n");
    request.push_str(body);
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes).await.unwrap();
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let mut lines = head.lines();
    let status = lines.next().and_then(|l| l.split_whitespace().nth(1)).and_then(|s| s.parse().ok()).unwrap_or(0);
    let headers = lines.filter_map(|l| l.split_once(": ").map(|(k, v)| (k.to_ascii_lowercase(), v.to_string()))).collect();
    (status, headers, body.to_string())
}

/// The device's half of the unlock exchange, as `mobile-web/src/secrets.ts`
/// does it in WebCrypto.
fn answer(device_id: &str, ecdh: &SecretKey, identity: &str, start: &Value) -> Value {
    let payload = start["payload"].as_str().unwrap();
    let identity = VerifyingKey::from(PublicKey::from_public_key_der(&unb64(identity)).unwrap());
    identity.verify(payload.as_bytes(), &Signature::from_slice(&unb64(start["signature"].as_str().unwrap())).unwrap()).expect("signed by the pinned identity");
    let lines: Vec<&str> = payload.split('\n').collect();
    let id = start["id"].as_str().unwrap();
    assert_eq!(&lines[1..], [ORIGIN, device_id, id, start["ephemeral"].as_str().unwrap(), start["transport"].as_str().unwrap()]);
    let transport_context = lines[0].replace(":unlock", ":transport");
    let x = PublicKey::from_sec1_bytes(&unb64(start["ephemeral"].as_str().unwrap())).unwrap();
    let released = p256::ecdh::diffie_hellman(ecdh.to_nonzero_scalar(), x.as_affine());
    let t = SecretKey::random(&mut rand::rngs::OsRng);
    let t_raw = t.public_key().to_encoded_point(false).as_bytes().to_vec();
    let e_raw = unb64(start["transport"].as_str().unwrap());
    let shared = p256::ecdh::diffie_hellman(t.to_nonzero_scalar(), PublicKey::from_sec1_bytes(&e_raw).unwrap().as_affine());
    let mut salt = e_raw.clone();
    salt.extend_from_slice(&t_raw);
    let key = vault::hkdf32(&salt, shared.raw_secret_bytes(), &format!("{transport_context}{id}"));
    let nonce = [9u8; 12];
    let sealed = Aes256Gcm::new_from_slice(key.as_ref())
        .unwrap()
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: released.raw_secret_bytes().as_slice(), aad: format!("{device_id}\n{id}").as_bytes() })
        .unwrap();
    json!({ "id": id, "transport": b64(&t_raw), "nonce": b64(&nonce), "sealed": b64(&sealed) })
}

/// Pair with a fresh invite and sign in, as the phone does: the pairing
/// key, the device id, the session cookie.
async fn pair_and_sign_in(socket: &std::path::Path, state_dir: &std::path::Path, code: &str) -> (SigningKey, String, String) {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    auth::write_invite(&state_dir.join("mobile-control"), code, now + 600).unwrap();
    let signing = SigningKey::random(&mut rand::rngs::OsRng);
    let public_key = b64(signing.verifying_key().to_public_key_der().unwrap().as_bytes());
    let (status, _, body) = raw(socket, "POST", "/api/v1/pair", None, Some(&json!({ "code": code, "device_name": "Device", "public_key": public_key }).to_string())).await;
    assert_eq!(status, 201, "{body}");
    let device_id = serde_json::from_str::<Value>(&body).unwrap()["device_id"].as_str().unwrap().to_string();
    let (_, _, body) = raw(socket, "POST", "/api/v1/auth/challenge", None, Some(&json!({ "device_id": device_id }).to_string())).await;
    let challenge: Value = serde_json::from_str(&body).unwrap();
    let signature: Signature = signing.sign(challenge["payload"].as_str().unwrap().as_bytes());
    let session = json!({ "device_id": device_id, "nonce": challenge["nonce"], "signature": b64(&signature.to_bytes()) }).to_string();
    let (status, headers, body) = raw(socket, "POST", "/api/v1/auth/session", None, Some(&session)).await;
    assert_eq!(status, 200, "{body}");
    let cookie = headers.iter().find(|(k, _)| k == "set-cookie").unwrap().1.split(';').next().unwrap().to_string();
    (signing, device_id, cookie)
}

/// Enrol an ECDH key (signed); the identity the daemon answers.
async fn enrol(socket: &std::path::Path, cookie: &str, signing: &SigningKey, device_id: &str, ecdh: &SecretKey) -> String {
    let ecdh_public = b64(ecdh.public_key().to_encoded_point(false).as_bytes());
    let enrol_sig: Signature = signing.sign(vault::enrol_payload(ORIGIN, device_id, &ecdh_public).as_bytes());
    let (status, _, body) = raw(socket, "POST", "/api/v1/secrets/enrol", Some(cookie), Some(&json!({ "ecdh_public_key": ecdh_public, "signature": b64(&enrol_sig.to_bytes()) }).to_string())).await;
    assert_eq!(status, 200, "{body}");
    serde_json::from_str::<Value>(&body).unwrap()["identity"].as_str().unwrap().to_string()
}

/// A signed action body (set-up, a new recovery code), as `secretsCore.ts`.
async fn signed(socket: &std::path::Path, cookie: &str, signing: &SigningKey, device_id: &str, action: &str) -> String {
    let (status, _, body) = raw(socket, "POST", "/api/v1/secrets/challenge", Some(cookie), Some(&json!({ "action": action }).to_string())).await;
    assert_eq!(status, 200, "{body}");
    let challenge: Value = serde_json::from_str(&body).unwrap();
    let nonce = challenge["nonce"].as_str().unwrap();
    let payload = Vault::action_payload(ORIGIN, device_id, action, nonce, challenge["expiresAt"].as_u64().unwrap());
    let signature: Signature = signing.sign(payload.as_bytes());
    json!({ "nonce": nonce, "signature": b64(&signature.to_bytes()) }).to_string()
}

/// Lock, then release through the device's unlock exchange over HTTP.
async fn unlock(socket: &std::path::Path, cookie: &str, device_id: &str, ecdh: &SecretKey, identity: &str) -> (u16, String) {
    let (status, _, body) = raw(socket, "POST", "/api/v1/secrets/unlock", Some(cookie), Some("{}")).await;
    assert_eq!(status, 200, "{body}");
    let start: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(start["state"], "locked", "{body}");
    let finish = answer(device_id, ecdh, identity, &start);
    let (status, _, body) = raw(socket, "POST", "/api/v1/secrets/unlock/finish", Some(cookie), Some(&finish.to_string())).await;
    (status, body)
}

#[tokio::test]
async fn a_device_releases_the_key_that_seals_mail_and_saved_passwords() {
    let dir = tempfile::tempdir().unwrap();
    let state_dir = dir.path().join("state");
    std::fs::create_dir_all(&state_dir).unwrap();
    std::env::set_var(app_lib::brand::CURRENT.env_name("STATE_DIR"), &state_dir);
    let hold = Arc::new(MemoryHold::default());
    let vault = vault::install(Vault::new(state_dir.clone(), hold.clone()));

    let socket = dir.path().join("d.sock");
    let config = ServerConfig { state_dir: state_dir.clone(), socket_path: socket.clone(), gateway_uid: None, origin: ORIGIN.into(), content_origin: None };
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    auth::write_invite(&state_dir.join("mobile-control"), "12345678", now + 600).unwrap();
    tokio::spawn(async move {
        if let Err(error) = daemon::run(config).await {
            eprintln!("daemon: {error}");
        }
    });
    for _ in 0..200 {
        if socket.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    // Pair and sign in, as the phone does.
    let signing = SigningKey::random(&mut rand::rngs::OsRng);
    let public_key = b64(signing.verifying_key().to_public_key_der().unwrap().as_bytes());
    let (status, _, body) = raw(&socket, "POST", "/api/v1/pair", None, Some(&json!({ "code": "12345678", "device_name": "Phone", "public_key": public_key }).to_string())).await;
    assert_eq!(status, 201, "{body}");
    let device_id = serde_json::from_str::<Value>(&body).unwrap()["device_id"].as_str().unwrap().to_string();
    let (_, _, body) = raw(&socket, "POST", "/api/v1/auth/challenge", None, Some(&json!({ "device_id": device_id }).to_string())).await;
    let challenge: Value = serde_json::from_str(&body).unwrap();
    let signature: Signature = signing.sign(challenge["payload"].as_str().unwrap().as_bytes());
    let session = json!({ "device_id": device_id, "nonce": challenge["nonce"], "signature": b64(&signature.to_bytes()) }).to_string();
    let (status, headers, body) = raw(&socket, "POST", "/api/v1/auth/session", None, Some(&session)).await;
    assert_eq!(status, 200, "{body}");
    let cookie = headers.iter().find(|(k, _)| k == "set-cookie").unwrap().1.split(';').next().unwrap().to_string();

    let (status, _, body) = raw(&socket, "GET", "/api/v1/secrets", Some(&cookie), None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap(),
        json!({ "available": true, "setUp": false, "unlocked": false, "enrolled": false, "recoveryCode": false, "newCodeRecommended": false, "identity": null })
    );

    // Enrol an ECDH key: the session alone is not enough.
    let ecdh = SecretKey::random(&mut rand::rngs::OsRng);
    let ecdh_public = b64(ecdh.public_key().to_encoded_point(false).as_bytes());
    let (status, _, body) = raw(&socket, "POST", "/api/v1/secrets/enrol", Some(&cookie), Some(&json!({ "ecdh_public_key": ecdh_public, "signature": b64(&[0u8; 64]) }).to_string())).await;
    assert_eq!((status, body.contains("invalid_signature")), (400, true), "{body}");
    let enrol_sig: Signature = signing.sign(vault::enrol_payload(ORIGIN, &device_id, &ecdh_public).as_bytes());
    let (status, _, body) = raw(&socket, "POST", "/api/v1/secrets/enrol", Some(&cookie), Some(&json!({ "ecdh_public_key": ecdh_public, "signature": b64(&enrol_sig.to_bytes()) }).to_string())).await;
    assert_eq!(status, 200, "{body}");
    let identity = serde_json::from_str::<Value>(&body).unwrap()["identity"].as_str().unwrap().to_string();

    // Set up: the session cookie alone is refused (user decision
    // 2026-10-03), so is a signature by another key and a replay.
    let (status, _, body) = raw(&socket, "POST", "/api/v1/secrets/setup", Some(&cookie), Some("{}")).await;
    assert_eq!((status, body.contains("signature_required")), (403, true), "{body}");
    let stranger = SigningKey::random(&mut rand::rngs::OsRng);
    let forged = signed(&socket, &cookie, &stranger, &device_id, "secrets-setup").await;
    let (status, _, body) = raw(&socket, "POST", "/api/v1/secrets/setup", Some(&cookie), Some(&forged)).await;
    assert_eq!((status, body.contains("invalid_signature")), (403, true), "{body}");
    assert!(!vault.status().set_up);
    // Signed by the pairing key: the recovery code, once; the device is wrapped.
    let setup = signed(&socket, &cookie, &signing, &device_id, "secrets-setup").await;
    let (status, headers, body) = raw(&socket, "POST", "/api/v1/secrets/setup", Some(&cookie), Some(&setup)).await;
    assert_eq!(status, 200, "{body}");
    assert!(headers.iter().any(|(k, v)| k == "cache-control" && v == "no-store"));
    let first_code = serde_json::from_str::<Value>(&body).unwrap()["code"].as_str().unwrap().to_string();
    let (status, _, _) = raw(&socket, "POST", "/api/v1/secrets/setup", Some(&cookie), Some(&setup)).await;
    assert_eq!(status, 403, "a spent nonce");
    let again = signed(&socket, &cookie, &signing, &device_id, "secrets-setup").await;
    let (status, _, _) = raw(&socket, "POST", "/api/v1/secrets/setup", Some(&cookie), Some(&again)).await;
    assert_eq!(status, 409, "never a second key");
    assert_eq!(vault.status().wrapped_devices, 1);
    let (status, _, body) = raw(&socket, "GET", "/api/v1/secrets", Some(&cookie), None).await;
    assert_eq!(status, 200);
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["identity"].as_str(), Some(identity.as_str()), "the state names the identity a device compares");

    // A new recovery code: signed too.
    let (status, _, _) = raw(&socket, "POST", "/api/v1/secrets/recovery-code", Some(&cookie), Some("{}")).await;
    assert_eq!(status, 403);
    let body = signed(&socket, &cookie, &signing, &device_id, "secrets-recovery-code").await;
    let (status, _, body) = raw(&socket, "POST", "/api/v1/secrets/recovery-code", Some(&cookie), Some(&body)).await;
    assert_eq!(status, 200, "{body}");
    let code = serde_json::from_str::<Value>(&body).unwrap()["code"].as_str().unwrap().to_string();

    // The re-pin offer checks with the code, from the public fields only.
    let (status, _, body) = raw(&socket, "POST", "/api/v1/secrets/repin", Some(&cookie), Some("{}")).await;
    assert_eq!(status, 200, "{body}");
    let offer: Value = serde_json::from_str(&body).unwrap();
    let field = |name: &str| offer[name].as_str().unwrap().to_string();
    assert_eq!(field("identity"), identity);
    assert!(app_lib::services::server::secrets::check_repin(&code, &field("salt"), &field("ephemeral"), &field("nonce"), &field("sealed"), &field("authNonce"), ORIGIN, &identity, &field("binding")));

    // Mail and a saved password, sealed under it.
    let mail_dir = state_dir.join("mail");
    let keys = mail_crypt::enable_default(&mail_dir).expect("device mode on a server");
    assert_eq!(mail_crypt::read_key_file(&mail_dir).unwrap().unwrap().mode, mail_crypt::UnlockMode::Device);
    remote_credentials::set("imap:alice@mail.example", Some("hunter2")).unwrap();
    assert_eq!(remote_credentials::get("imap:alice@mail.example").as_deref(), Some("hunter2"));
    assert_eq!(remote_credentials::keyring_state(), remote_credentials::KeyringState::Unlocked);

    // A reboot: the keyring is empty. Mail and passwords are locked.
    hold.clear().unwrap();
    assert!(matches!(mail_crypt::unlock(&mail_dir), Unlock::Unavailable(why) if why == mail_crypt::DEVICE_LOCKED));
    assert_eq!(remote_credentials::get("imap:alice@mail.example"), None);
    assert_eq!(remote_credentials::keyring_state(), remote_credentials::KeyringState::Locked);
    assert!(remote_credentials::set("smtp:x", Some("y")).is_err());

    // The phone connects and releases K.
    let (status, _, body) = raw(&socket, "POST", "/api/v1/secrets/unlock", Some(&cookie), Some("{}")).await;
    assert_eq!(status, 200, "{body}");
    let start: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(start["state"], "locked");
    let finish = answer(&device_id, &ecdh, &identity, &start);
    let (status, _, body) = raw(&socket, "POST", "/api/v1/secrets/unlock/finish", Some(&cookie), Some(&finish.to_string())).await;
    assert_eq!(status, 200, "{body}");
    match mail_crypt::unlock(&mail_dir) {
        Unlock::Ready(opened) => assert_eq!(opened.field.as_bytes(), keys.field.as_bytes()),
        other => panic!("{other:?}"),
    }
    assert_eq!(remote_credentials::get("imap:alice@mail.example").as_deref(), Some("hunter2"));
    // The same answer again is refused: the exchange was spent.
    let (status, _, _) = raw(&socket, "POST", "/api/v1/secrets/unlock/finish", Some(&cookie), Some(&finish.to_string())).await;
    assert_eq!(status, 400);

    // Every device lost: the recovery code still opens it.
    hold.clear().unwrap();
    let (status, _, _) = raw(&socket, "POST", "/api/v1/secrets/recover", Some(&cookie), Some(&json!({ "code": "0000-0000-0000-0000-0000-0000-0000-0000" }).to_string())).await;
    assert_eq!(status, 400);
    let (status, _, body) = raw(&socket, "POST", "/api/v1/secrets/recover", Some(&cookie), Some(&json!({ "code": code }).to_string())).await;
    assert_eq!(status, 200, "{body}");
    assert!(hold.get().unwrap().is_some());

    // The phone enrols a new ECDH key (its browser lost the old one): the
    // wrap made for the old key is replaced, so the new key releases K.
    let ecdh2 = SecretKey::random(&mut rand::rngs::OsRng);
    let ecdh2_public = b64(ecdh2.public_key().to_encoded_point(false).as_bytes());
    let enrol_sig: Signature = signing.sign(vault::enrol_payload(ORIGIN, &device_id, &ecdh2_public).as_bytes());
    let (status, _, body) = raw(&socket, "POST", "/api/v1/secrets/enrol", Some(&cookie), Some(&json!({ "ecdh_public_key": ecdh2_public, "signature": b64(&enrol_sig.to_bytes()) }).to_string())).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["identity"].as_str(), Some(identity.as_str()), "the identity key is stable");
    assert_eq!(vault.status().wrapped_devices, 1);
    hold.clear().unwrap();
    let (status, _, body) = raw(&socket, "POST", "/api/v1/secrets/unlock", Some(&cookie), Some("{}")).await;
    assert_eq!(status, 200, "{body}");
    let start: Value = serde_json::from_str(&body).unwrap();
    let finish = answer(&device_id, &ecdh2, &identity, &start);
    let (status, _, body) = raw(&socket, "POST", "/api/v1/secrets/unlock/finish", Some(&cookie), Some(&finish.to_string())).await;
    assert_eq!(status, 200, "the new key releases K: {body}");
    assert!(hold.get().unwrap().is_some());

    // A second device (a tablet) pairs and enrols while unlocked: wrapped.
    let (tablet_signing, tablet_id, tablet_cookie) = pair_and_sign_in(&socket, &state_dir, "87654321").await;
    let tablet_ecdh = SecretKey::random(&mut rand::rngs::OsRng);
    enrol(&socket, &tablet_cookie, &tablet_signing, &tablet_id, &tablet_ecdh).await;
    assert_eq!(vault.status().wrapped_devices, 2);

    // Revoking the phone rotates K: mail and the saved password still open
    // under the new one, and the phone's old wrap is no use.
    let k_before = hold.get().unwrap().unwrap();
    let old_wraps = std::fs::read_to_string(state_dir.join("secrets/wraps.json")).unwrap();
    let (revoke_dir, revoke_id) = (state_dir.clone(), device_id.clone());
    tokio::task::spawn_blocking(move || daemon::revoke_device(&revoke_dir, &revoke_id)).await.unwrap().unwrap();
    let k_after = hold.get().unwrap().expect("still unlocked");
    assert_ne!(k_after.bytes(), k_before.bytes(), "a new K");
    assert!(old_wraps.contains(&device_id) && !std::fs::read_to_string(state_dir.join("secrets/wraps.json")).unwrap().contains(&device_id));
    match mail_crypt::unlock(&mail_dir) {
        Unlock::Ready(opened) => assert_eq!(opened.field.as_bytes(), keys.field.as_bytes()),
        other => panic!("{other:?}"),
    }
    assert_eq!(remote_credentials::get("imap:alice@mail.example").as_deref(), Some("hunter2"));
    let (status, _, _) = raw(&socket, "GET", "/api/v1/secrets", Some(&cookie), None).await;
    assert_eq!(status, 401, "the phone's session went with it");
    // The tablet's Server settings: a new recovery code is recommended.
    let (status, _, body) = raw(&socket, "GET", "/api/v1/secrets", Some(&tablet_cookie), None).await;
    assert_eq!(status, 200, "{body}");
    let state: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(state["newCodeRecommended"], true, "{state}");
    // A reboot: the tablet releases the new K; the recovery code still fits.
    hold.clear().unwrap();
    let (status, body) = unlock(&socket, &tablet_cookie, &tablet_id, &tablet_ecdh, &identity).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(hold.get().unwrap().unwrap().bytes(), k_after.bytes());
    assert_eq!(remote_credentials::get("imap:alice@mail.example").as_deref(), Some("hunter2"));
    hold.clear().unwrap();
    let (status, _, _) = raw(&socket, "POST", "/api/v1/secrets/recover", Some(&tablet_cookie), Some(&json!({ "code": first_code }).to_string())).await;
    assert_eq!(status, 400, "the code the new one replaced");
    let (status, _, body) = raw(&socket, "POST", "/api/v1/secrets/recover", Some(&tablet_cookie), Some(&json!({ "code": code }).to_string())).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(hold.get().unwrap().unwrap().bytes(), k_after.bytes());

    // A new recovery code (signed, by the remaining tablet) clears the advice.
    let body = signed(&socket, &tablet_cookie, &tablet_signing, &tablet_id, "secrets-recovery-code").await;
    let (status, _, body) = raw(&socket, "POST", "/api/v1/secrets/recovery-code", Some(&tablet_cookie), Some(&body)).await;
    assert_eq!(status, 200, "{body}");
    let (_, _, body) = raw(&socket, "GET", "/api/v1/secrets", Some(&tablet_cookie), None).await;
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["newCodeRecommended"], false);
}

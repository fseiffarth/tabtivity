//! The gateway against fake daemons on real unix sockets: routing by code
//! prefix and by device, the routing cookie, header hygiene, revocation of
//! live sockets, the peer check, the content origin, the policy and the
//! audit log's "no content" promise.

use super::*;
use crate::db;
use axum::extract::ws::{Message as AxMessage, WebSocketUpgrade};
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UnixListener};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message as WsMessage};

const ORIGIN: &str = "https://desk.example.ts.net";
const HOST: &str = "desk.example.ts.net";
const CONTENT_HOST: &str = "desk.example.ts.net:8443";

fn own_uid() -> u32 {
    // SAFETY: getuid has no preconditions.
    unsafe { libc::getuid() }
}

/// One fake daemon: answers as `user`, mints `device_id` on a good pair.
async fn fake_daemon(socket: std::path::PathBuf, user: &'static str, device_id: &'static str) {
    async fn echo(headers: HeaderMap, body: Bytes) -> Json<Value> {
        let map: serde_json::Map<String, Value> = headers.iter().map(|(k, v)| (k.as_str().to_string(), Value::String(v.to_str().unwrap_or("").to_string()))).collect();
        Json(json!({ "headers": map, "body": String::from_utf8_lossy(&body) }))
    }
    let app = Router::new()
        .route(
            "/api/v1/pair",
            post(move |Json(body): Json<Value>| async move {
                if body["code"] == "12345678" {
                    (StatusCode::CREATED, Json(json!({ "device_id": device_id })))
                } else {
                    (StatusCode::BAD_REQUEST, Json(json!({ "error": "invalid_pairing_code", "got": body["code"] })))
                }
            }),
        )
        .route("/api/v1/auth/challenge", post(move || async move { Json(json!({ "nonce": "n", "daemon": user })) }))
        .route(
            "/api/v1/auth/session",
            post(move || async move { ([(header::SET_COOKIE, format!("{}=tok-{user}; Path=/", crate::brand::SESSION_COOKIE))], Json(json!({ "ok": true }))) }).delete(|| async { Json(json!({ "ok": true })) }),
        )
        .route("/echo", get(echo).post(echo))
        .route("/content/{ticket}", get(move |RoutePath(t): RoutePath<String>, headers: HeaderMap| async move { format!("content:{user}:{t}:{}", headers.get(header::COOKIE).is_some()) }))
        .route(
            "/ws",
            get(|ws: WebSocketUpgrade| async move {
                ws.on_upgrade(|mut socket| async move {
                    while let Some(Ok(message)) = socket.recv().await {
                        if let AxMessage::Text(t) = message {
                            if socket.send(AxMessage::Text(t)).await.is_err() {
                                break;
                            }
                        }
                    }
                })
            }),
        );
    let listener = UnixListener::bind(&socket).unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
}

struct Fixture {
    _dir: tempfile::TempDir,
    gw: Shared,
    addr: std::net::SocketAddr,
    content_addr: std::net::SocketAddr,
}

async fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("state");
    let sockets = dir.path().join("users");
    let pwa = dir.path().join("pwa");
    for d in [&state, &sockets, &pwa] {
        std::fs::create_dir_all(d).unwrap();
    }
    std::fs::write(pwa.join("index.html"), "<html>pwa</html>").unwrap();
    let uid = own_uid();
    db::update(&state, |db| {
        db.add_account("alice", uid, Role::User, 1)?;
        db.add_account("root_admin", uid.wrapping_add(7), Role::Admin, 1)?;
        // Bob's daemon runs as another uid than the table says: refused.
        db.add_account("bob", uid.wrapping_add(1), Role::User, 1)?;
        // Carol has no daemon at all and no invite pending.
        db.add_account("carol", uid.wrapping_add(2), Role::User, 1)?;
        db.set_invite("alice", u64::MAX)?;
        db.set_invite("bob", u64::MAX)
    })
    .unwrap();
    fake_daemon(wire::socket_path(&sockets, "alice"), "alice", "alice_device_01").await;
    fake_daemon(wire::socket_path(&sockets, "bob"), "bob", "bob_device_0001").await;
    let config = GatewayConfig {
        listen: "127.0.0.1:0".parse().unwrap(),
        content_listen: Some("127.0.0.1:0".parse().unwrap()),
        origin: ORIGIN.into(),
        content_origin: Some(format!("https://{CONTENT_HOST}")),
        state_dir: state,
        socket_dir: sockets,
        pwa_dir: pwa,
    };
    let gw = Gateway::open(config).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = router(gw.clone());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let content_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let content_addr = content_listener.local_addr().unwrap();
    let content_app = content_router(gw.clone());
    tokio::spawn(async move { axum::serve(content_listener, content_app).await.unwrap() });
    Fixture { _dir: dir, gw, addr, content_addr }
}

/// One HTTP/1.1 request, `Connection: close`: `(status, headers, body)`.
async fn raw(addr: std::net::SocketAddr, method: &str, path: &str, headers: &[(&str, &str)], body: Option<&str>) -> (u16, Vec<(String, String)>, String) {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let mut request = format!("{method} {path} HTTP/1.1\r\nConnection: close\r\n");
    if !headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("host")) {
        request.push_str(&format!("Host: {HOST}\r\n"));
    }
    for (k, v) in headers {
        request.push_str(&format!("{k}: {v}\r\n"));
    }
    if let Some(body) = body {
        request.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", body.len()));
    }
    request.push_str("\r\n");
    if let Some(body) = body {
        request.push_str(body);
    }
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

fn set_cookies(headers: &[(String, String)]) -> Vec<String> {
    headers.iter().filter(|(k, _)| k == "set-cookie").map(|(_, v)| v.split(';').next().unwrap().to_string()).collect()
}

/// Pair Alice's first device and sign it in: the `Cookie` header to use.
async fn sign_in_alice(f: &Fixture) -> String {
    let pair = json!({ "code": "alice:12345678", "device_name": "Laptop", "public_key": "k" }).to_string();
    let (status, _, body) = raw(f.addr, "POST", "/api/v1/pair", &[("Origin", ORIGIN)], Some(&pair)).await;
    assert_eq!(status, 201, "{body}");
    let session = json!({ "device_id": "alice_device_01", "nonce": "n", "signature": "s" }).to_string();
    let (status, headers, body) = raw(f.addr, "POST", "/api/v1/auth/session", &[("Origin", ORIGIN)], Some(&session)).await;
    assert_eq!(status, 200, "{body}");
    let cookies = set_cookies(&headers);
    assert_eq!(cookies.len(), 2, "the daemon's session and the routing cookie: {headers:?}");
    cookies.join("; ")
}

#[tokio::test]
async fn pairing_routes_by_the_code_prefix_and_records_the_device() {
    let f = fixture().await;
    // Wrong code: the daemon's own answer, and the digits alone reached it.
    let bad = json!({ "code": "alice:00000000", "device_name": "L", "public_key": "k" }).to_string();
    let (status, _, body) = raw(f.addr, "POST", "/api/v1/pair", &[("Origin", ORIGIN)], Some(&bad)).await;
    assert_eq!(status, 400);
    assert!(body.contains("\"got\":\"00000000\""), "the prefix is stripped: {body}");
    // Unknown account and a code with no prefix answer like a wrong code.
    for code in ["zed:12345678", "12345678"] {
        let body = json!({ "code": code, "device_name": "L", "public_key": "k" }).to_string();
        let (status, _, answer) = raw(f.addr, "POST", "/api/v1/pair", &[("Origin", ORIGIN)], Some(&body)).await;
        assert_eq!((status, answer.contains("invalid_pairing_code")), (400, true), "{code}: {answer}");
    }
    // A foreign Origin never reaches a daemon.
    let good = json!({ "code": "alice:12345678", "device_name": "Laptop", "public_key": "k" }).to_string();
    let (status, _, _) = raw(f.addr, "POST", "/api/v1/pair", &[("Origin", "https://evil.example")], Some(&good)).await;
    assert_eq!(status, 403);
    let (status, _, _) = raw(f.addr, "POST", "/api/v1/pair", &[("Origin", ORIGIN)], Some(&good)).await;
    assert_eq!(status, 201);
    assert_eq!(f.gw.db().owner_of("alice_device_01").unwrap().name, "alice");
    let rows = f.gw.audit.rows();
    assert!(rows.iter().any(|r| r.user == "alice" && r.verb == "pair" && r.result == "ok" && r.device.as_deref() == Some("alice_device_01")));
}

/// Bob's table row names another uid than the one answering on his socket:
/// whatever listens there is not Bob's daemon, so nothing is forwarded. (A
/// daemon answering a pair with another account's device id is refused by
/// the table, `db::tests::a_device_routes_to_one_account_only`; one uid per
/// account keeps a second real daemon out of a single-uid test.)
#[tokio::test]
async fn a_socket_of_the_wrong_uid_is_not_the_accounts_daemon() {
    let f = fixture().await;
    let pair = json!({ "code": "bob:12345678", "device_name": "x", "public_key": "k" }).to_string();
    let (status, _, body) = raw(f.addr, "POST", "/api/v1/pair", &[("Origin", ORIGIN)], Some(&pair)).await;
    assert_eq!((status, body.contains("daemon_unavailable")), (502, true), "{body}");
    assert!(f.gw.db().owner_of("bob_device_0001").is_none());
    assert!(f.gw.audit.rows().iter().any(|r| r.user == "bob" && r.verb == "pair" && r.result == "refused"));
}

#[tokio::test]
async fn a_signed_in_device_reaches_only_its_own_daemon_with_the_gateways_headers() {
    let f = fixture().await;
    let cookie = sign_in_alice(&f).await;
    // The client tries to claim admin and another user; the gateway's own
    // headers replace them, and the routing cookie stays at the gateway.
    let (status, _, body) = raw(f.addr, "GET", "/echo", &[("Cookie", &cookie), ("X-Gateway-Role", "admin"), ("X-Gateway-User", "bob")], None).await;
    assert_eq!(status, 200, "{body}");
    let v: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["headers"]["x-gateway-user"], "alice");
    assert_eq!(v["headers"]["x-gateway-role"], "user");
    assert_eq!(v["headers"]["x-gateway-device"], "alice_device_01");
    let forwarded = v["headers"]["cookie"].as_str().unwrap();
    assert!(forwarded.contains(crate::brand::SESSION_COOKIE) && !forwarded.contains(crate::brand::GATEWAY_COOKIE), "{forwarded}");
    // A forged or foreign-key cookie routes nowhere.
    let forged = RoutingKey::from_bytes([1; 32]).mint("alice", "alice_device_01", crate::now() + 60);
    let (status, _, _) = raw(f.addr, "GET", "/api/v1/status", &[("Cookie", &format!("{}={forged}", crate::brand::GATEWAY_COOKIE))], None).await;
    assert_eq!(status, 401);
    // Unrouted: the API is closed, the desktop asks for pairing, the PWA is served.
    let (status, _, _) = raw(f.addr, "GET", "/api/v1/status", &[], None).await;
    assert_eq!(status, 401);
    let (status, headers, body) = raw(f.addr, "GET", "/desktop/", &[], None).await;
    assert_eq!(status, 401);
    assert!(body.contains("invite code"));
    assert!(headers.iter().any(|(k, v)| k == "content-security-policy" && v.contains("default-src 'self'")));
    let (status, _, body) = raw(f.addr, "GET", "/", &[], None).await;
    assert_eq!((status, body.as_str()), (200, "<html>pwa</html>"));
    // Another Host is nobody's.
    let (status, _, _) = raw(f.addr, "GET", "/", &[("Host", "127.0.0.1")], None).await;
    assert_eq!(status, 404);
    // Logout clears the routing cookie.
    let (status, headers, _) = raw(f.addr, "DELETE", "/api/v1/auth/session", &[("Cookie", &cookie), ("Origin", ORIGIN)], None).await;
    assert_eq!(status, 200);
    assert!(headers.iter().any(|(k, v)| k == "set-cookie" && v.starts_with(crate::brand::GATEWAY_COOKIE) && v.contains("Max-Age=0")));
    // A challenge for an unknown device is refused at the gateway.
    let (status, _, body) = raw(f.addr, "POST", "/api/v1/auth/challenge", &[("Origin", ORIGIN)], Some(r#"{"device_id":"nobody_device_1"}"#)).await;
    assert_eq!((status, body.contains("unknown_device")), (400, true));
}

#[tokio::test]
async fn revoking_a_device_closes_its_live_socket_and_its_routing() {
    let f = fixture().await;
    let cookie = sign_in_alice(&f).await;
    let stream = TcpStream::connect(f.addr).await.unwrap();
    let mut request = format!("ws://{HOST}/ws").into_client_request().unwrap();
    request.headers_mut().insert("cookie", cookie.parse().unwrap());
    let (mut ws, _) = tokio_tungstenite::client_async(request, stream).await.expect("upgrade through the gateway");
    ws.send(WsMessage::Text("ping".into())).await.unwrap();
    assert_eq!(ws.next().await.unwrap().unwrap(), WsMessage::Text("ping".into()));
    assert_eq!(f.gw.live_count(), 1);
    db::update(&f.gw.config.state_dir, |db| db.revoke_device("alice", "alice_device_01")).unwrap();
    // The file's mtime may not move within one tick on a coarse clock; force.
    *f.gw.db_stamp.lock().unwrap() = None;
    f.gw.reload();
    let closed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match ws.next().await {
                None | Some(Err(_)) | Some(Ok(WsMessage::Close(_))) => break,
                Some(Ok(_)) => {}
            }
        }
    })
    .await;
    assert!(closed.is_ok(), "the revoked device's socket is closed");
    let (status, _, body) = raw(f.addr, "GET", "/echo", &[("Cookie", &cookie)], None).await;
    assert_eq!((status, body.as_str()), (200, "<html>pwa</html>"), "its cookie routes nowhere: the gateway's own PWA answers");
    let (status, _, _) = raw(f.addr, "GET", "/api/v1/status", &[("Cookie", &cookie)], None).await;
    assert_eq!(status, 401);
    assert!(f.gw.audit.rows().iter().all(|r| r.verb != "pair" || r.user == "alice"));
}

/// The daemon fixes a socket's role when it opens; a demoted admin's open
/// socket must not keep the old role, so the gateway closes it.
#[tokio::test]
async fn a_role_change_closes_the_accounts_live_sockets() {
    let f = fixture().await;
    let cookie = sign_in_alice(&f).await;
    let stream = TcpStream::connect(f.addr).await.unwrap();
    let mut request = format!("ws://{HOST}/ws").into_client_request().unwrap();
    request.headers_mut().insert("cookie", cookie.parse().unwrap());
    let (mut ws, _) = tokio_tungstenite::client_async(request, stream).await.expect("upgrade through the gateway");
    ws.send(WsMessage::Text("ping".into())).await.unwrap();
    assert_eq!(ws.next().await.unwrap().unwrap(), WsMessage::Text("ping".into()));
    // Nothing changed: a reload leaves it open.
    *f.gw.db_stamp.lock().unwrap() = None;
    f.gw.reload();
    assert_eq!(f.gw.live_count(), 1);
    db::update(&f.gw.config.state_dir, |db| db.set_role("alice", Role::Admin)).unwrap();
    *f.gw.db_stamp.lock().unwrap() = None;
    f.gw.reload();
    let closed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match ws.next().await {
                None | Some(Err(_)) | Some(Ok(WsMessage::Close(_))) => break,
                Some(Ok(_)) => {}
            }
        }
    })
    .await;
    assert!(closed.is_ok(), "the socket opened under the old role is closed");
    assert_eq!(f.gw.live_count(), 0);
    // The device still routes; a new request carries the new role.
    let (status, _, body) = raw(f.addr, "GET", "/echo", &[("Cookie", &cookie)], None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["headers"]["x-gateway-role"], "admin");
}

#[tokio::test]
async fn the_content_origin_routes_by_user_and_strips_cookies() {
    let f = fixture().await;
    let (status, _, body) = raw(f.content_addr, "GET", "/content/alice/tkt_1", &[("Host", CONTENT_HOST), ("Cookie", "a=b")], None).await;
    assert_eq!((status, body.as_str()), (200, "content:alice:tkt_1:false"));
    let (status, _, _) = raw(f.content_addr, "GET", "/content/alice/tkt_1", &[("Host", HOST)], None).await;
    assert_eq!(status, 404, "only on the content host");
    let (status, _, _) = raw(f.content_addr, "GET", "/content/zed/tkt_1", &[("Host", CONTENT_HOST)], None).await;
    assert_eq!(status, 404);
    let (status, _, _) = raw(f.content_addr, "GET", "/content/alice/a.b", &[("Host", CONTENT_HOST)], None).await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn only_an_admin_writes_the_policy() {
    let f = fixture().await;
    let cookie = sign_in_alice(&f).await;
    let body = json!({ "schema": 1, "features": { "mail": false, "calendar": true, "todo": true, "calendar_sharing": false }, "ollama_allowed_models": ["llama3"] }).to_string();
    let (status, _, _) = raw(f.addr, "PUT", "/gateway/v1/policy", &[("Cookie", &cookie), ("Origin", ORIGIN)], Some(&body)).await;
    assert_eq!(status, 403);
    assert!(!f.gw.config.policy_path().exists());
    db::update(&f.gw.config.state_dir, |db| db.set_role("alice", Role::Admin)).unwrap();
    *f.gw.db_stamp.lock().unwrap() = None;
    f.gw.reload();
    let (status, _, _) = raw(f.addr, "PUT", "/gateway/v1/policy", &[("Cookie", &cookie), ("Origin", "https://evil.example")], Some(&body)).await;
    assert_eq!(status, 403);
    let (status, _, answer) = raw(f.addr, "PUT", "/gateway/v1/policy", &[("Cookie", &cookie), ("Origin", ORIGIN)], Some(&body)).await;
    assert_eq!(status, 200, "{answer}");
    let written = Policy::load(&f.gw.config.policy_path()).unwrap();
    assert!(!written.features.mail);
    assert_eq!(written.ollama_allowed_models, Some(vec!["llama3".to_string()]));
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(std::fs::metadata(f.gw.config.policy_path()).unwrap().permissions().mode() & 0o777, 0o644, "every daemon reads it");
    let (status, _, answer) = raw(f.addr, "GET", "/gateway/v1/status", &[("Cookie", &cookie)], None).await;
    assert_eq!(status, 200);
    let v: Value = serde_json::from_str(&answer).unwrap();
    let alice = v["accounts"].as_array().unwrap().iter().find(|a| a["name"] == "alice").unwrap();
    assert_eq!((alice["socket"].as_str(), alice["devices"].as_u64()), (Some("present"), Some(1)));
    let zed = v["accounts"].as_array().unwrap().iter().find(|a| a["name"] == "root_admin").unwrap();
    assert_eq!(zed["socket"], "missing", "looked at, not connected to");
}

#[tokio::test]
async fn the_gateway_keeps_no_content() {
    let f = fixture().await;
    let cookie = sign_in_alice(&f).await;
    let planted = "Planted Subject Quarterly Budget";
    let (status, _, body) = raw(f.addr, "POST", "/echo", &[("Cookie", &cookie), ("Origin", ORIGIN)], Some(&json!({ "subject": planted, "title": planted }).to_string())).await;
    assert_eq!(status, 200);
    assert!(body.contains(planted), "the daemon got it");
    let (_, _, audit) = raw(f.addr, "GET", "/gateway/v1/audit", &[("Cookie", &cookie)], None).await;
    assert!(audit.contains("\"login\""), "{audit}");
    for file in std::fs::read_dir(&f.gw.config.state_dir).unwrap() {
        let bytes = std::fs::read(file.unwrap().path()).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains(planted));
    }
}

/// P3 review finding 13: a pair for an account with no invite pending (and
/// no recent use) answers like an unknown account and connects to no socket
/// — so it starts no daemon by socket activation and says nothing about
/// whether the account exists.
#[tokio::test]
async fn a_pair_without_a_pending_invite_reaches_no_daemon() {
    let f = fixture().await;
    let body = json!({ "code": "carol:12345678", "device_name": "x", "public_key": "k" }).to_string();
    let (status, _, answer) = raw(f.addr, "POST", "/api/v1/pair", &[("Origin", ORIGIN)], Some(&body)).await;
    assert_eq!((status, answer.contains("invalid_pairing_code")), (400, true), "not 502: nothing was connected to: {answer}");
    let unknown = json!({ "code": "zed:12345678", "device_name": "x", "public_key": "k" }).to_string();
    let (_, _, unknown_answer) = raw(f.addr, "POST", "/api/v1/pair", &[("Origin", ORIGIN)], Some(&unknown)).await;
    assert_eq!(answer, unknown_answer, "the same answer as for nobody");
    // Once the helper records an invite, the pair is forwarded (and fails
    // here only because Carol has no daemon).
    db::update(&f.gw.config.state_dir, |db| db.set_invite("carol", crate::now() + 60)).unwrap();
    f.gw.reload();
    let (status, _, _) = raw(f.addr, "POST", "/api/v1/pair", &[("Origin", ORIGIN)], Some(&body)).await;
    assert_eq!(status, 502);
}

/// P3 review finding 12: strangers flooding the pair and sign-in routes from
/// many tailnet sources do not lock a paired user out.
#[tokio::test]
async fn a_stranger_flood_does_not_lock_out_a_known_user() {
    let f = fixture().await;
    let cookie_before = sign_in_alice(&f).await;
    assert!(!cookie_before.is_empty());
    for n in 0..(crate::rate::AUTH_STRANGERS + 50) {
        let source = format!("2001:db8:{:x}::{:x}", n / 250, n % 250);
        let body = json!({ "device_id": format!("ghost_device_{n:04}"), "nonce": "n", "signature": "s" }).to_string();
        raw(f.addr, "POST", "/api/v1/auth/challenge", &[("Origin", ORIGIN), ("X-Forwarded-For", &source)], Some(&body)).await;
    }
    for n in 0..(crate::rate::PAIR_STRANGERS + 20) {
        let source = format!("2001:db8:1{:x}::{:x}", n / 250, n % 250);
        let body = json!({ "code": format!("zed{n}:12345678"), "device_name": "x", "public_key": "k" }).to_string();
        raw(f.addr, "POST", "/api/v1/pair", &[("Origin", ORIGIN), ("X-Forwarded-For", &source)], Some(&body)).await;
    }
    // The stranger windows are shut …
    let ghost = json!({ "device_id": "ghost_device_9999", "nonce": "n", "signature": "s" }).to_string();
    let (status, _, _) = raw(f.addr, "POST", "/api/v1/auth/challenge", &[("Origin", ORIGIN), ("X-Forwarded-For", "198.51.100.66")], Some(&ghost)).await;
    assert_eq!(status, 429);
    // … and Alice's device still signs in, from the very same source.
    let session = json!({ "device_id": "alice_device_01", "nonce": "n", "signature": "s" }).to_string();
    let (status, _, body) = raw(f.addr, "POST", "/api/v1/auth/session", &[("Origin", ORIGIN), ("X-Forwarded-For", "198.51.100.66")], Some(&session)).await;
    assert_eq!(status, 200, "{body}");
    // One source spamming Alice's device id is limited on that device only.
    for _ in 0..crate::rate::AUTH_PER_DEVICE {
        raw(f.addr, "POST", "/api/v1/auth/challenge", &[("Origin", ORIGIN)], Some(&session)).await;
    }
    let (status, _, _) = raw(f.addr, "POST", "/api/v1/auth/challenge", &[("Origin", ORIGIN)], Some(&session)).await;
    assert_eq!(status, 429);
}

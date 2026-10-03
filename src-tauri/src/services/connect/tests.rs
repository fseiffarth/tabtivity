//! Pairing, sign-in, the socket and a download against a fake server on
//! loopback (plain HTTP, allowed in tests only): the requests carry what the
//! real daemon and gateway check — the exact `Origin`, a raw `r‖s`
//! signature of the challenge payload, both cookies on the upgrade, the
//! desktop subprotocol.

use super::*;
use axum::extract::ws::{Message, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct Seen {
    public_key: Option<String>,
}

async fn fake_server() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Seen::default()));
    let o = origin.clone();
    let origin_ok = move |headers: &HeaderMap| headers.get("origin").and_then(|v| v.to_str().ok()) == Some(o.as_str());
    let (pair_ok, challenge_ok, session_ok, ws_ok) = (origin_ok.clone(), origin_ok.clone(), origin_ok.clone(), origin_ok);
    let (s1, s2) = (seen.clone(), seen);
    let app = Router::new()
        .route(
            "/api/v1/pair",
            post(move |headers: HeaderMap, Json(body): Json<serde_json::Value>| async move {
                if !pair_ok(&headers) || body["code"] != "alice:12345678" {
                    return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "invalid_pairing_code" })));
                }
                s1.lock().unwrap().public_key = body["public_key"].as_str().map(str::to_string);
                (StatusCode::CREATED, Json(serde_json::json!({ "device_id": "desk_device_01" })))
            }),
        )
        .route(
            "/api/v1/auth/challenge",
            post(move |headers: HeaderMap, Json(body): Json<serde_json::Value>| async move {
                assert!(challenge_ok(&headers) && body["device_id"] == "desk_device_01");
                Json(serde_json::json!({ "nonce": "n1", "payload": "sign this" }))
            }),
        )
        .route(
            "/api/v1/auth/session",
            post(move |headers: HeaderMap, Json(body): Json<serde_json::Value>| async move {
                use p256::ecdsa::signature::Verifier;
                use p256::pkcs8::DecodePublicKey;
                let der = Base64UrlUnpadded::decode_vec(s2.lock().unwrap().public_key.as_deref().unwrap()).unwrap();
                let key = p256::ecdsa::VerifyingKey::from_public_key_der(&der).unwrap();
                let signature = p256::ecdsa::Signature::from_slice(&Base64UrlUnpadded::decode_vec(body["signature"].as_str().unwrap()).unwrap()).unwrap();
                if !session_ok(&headers) || key.verify(b"sign this", &signature).is_err() {
                    return (StatusCode::UNAUTHORIZED, HeaderMap::new(), Json(serde_json::json!({ "error": "invalid_signature" })));
                }
                let mut out = HeaderMap::new();
                out.append("set-cookie", "app_session=s1; Path=/; Secure; HttpOnly".parse().unwrap());
                out.append("set-cookie", "routing=r1; Path=/; Secure".parse().unwrap());
                (StatusCode::OK, out, Json(serde_json::json!({ "ok": true })))
            }),
        )
        .route(
            "/api/v1/desktop/ws",
            get(move |headers: HeaderMap, ws: WebSocketUpgrade| async move {
                let cookies = headers.get("cookie").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
                let protocol = headers.get("sec-websocket-protocol").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
                if !ws_ok(&headers) || cookies != "app_session=s1; routing=r1" || protocol != crate::brand::DESKTOP_PROTOCOL {
                    return StatusCode::FORBIDDEN.into_response();
                }
                ws.protocols([crate::brand::DESKTOP_PROTOCOL]).on_upgrade(|mut socket| async move {
                    let _ = socket.send(Message::Text(r#"{"t":"hello"}"#.into())).await;
                    while let Some(Ok(Message::Text(text))) = socket.recv().await {
                        let _ = socket.send(Message::Text(format!("echo:{text}").into())).await;
                    }
                })
            }),
        )
        .route(
            "/content/t1",
            get(|| async { ([("content-disposition", "attachment; filename=\"../report.pdf\"")], "PDFBYTES") }),
        );
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    origin
}

use axum::response::IntoResponse;

#[tokio::test]
async fn pairs_signs_in_and_opens_the_desktop_socket_as_the_servers_own_page() {
    let origin = fake_server().await;
    let dir = tempfile::tempdir().unwrap();
    assert!(paired_in(dir.path()).is_none());
    assert!(pair_in(dir.path(), &origin, "alice:00000000", "Desk").await.unwrap_err().contains("invalid_pairing_code"));
    assert!(paired_in(dir.path()).is_none(), "a refused code keeps nothing");
    let paired = pair_in(dir.path(), &origin, "alice:12345678", " Desk ").await.unwrap();
    assert_eq!((paired.device_id.as_str(), paired.device_name.as_str()), ("desk_device_01", "Desk"));
    assert_eq!(paired_in(dir.path()), Some(paired));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(dir_in(dir.path()).join(KEY_FILE)).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "the pairing key is private");
    }
    let session = sign_in(dir.path()).await.unwrap();
    assert_eq!(session.cookies, "app_session=s1; routing=r1");
    assert!(!format!("{session:?}").contains("s1"), "cookies never reach a log line");
    let mut socket = open_socket(&session, Some("client-7")).await.unwrap();
    let hello = socket.next().await.unwrap().unwrap();
    assert_eq!(hello.into_text().unwrap().as_str(), r#"{"t":"hello"}"#);
    socket.send(tokio_tungstenite::tungstenite::Message::Text("ping".into())).await.unwrap();
    assert_eq!(socket.next().await.unwrap().unwrap().into_text().unwrap().as_str(), "echo:ping");
    // Open after a download: only the server's content address, a safe name.
    let downloads = dir.path().join("downloads");
    let path = download_ticket(&origin, &format!("{origin}/content/t1"), &downloads).await.unwrap();
    assert_eq!(path, downloads.join("report.pdf"));
    assert_eq!(std::fs::read(&path).unwrap(), b"PDFBYTES");
    let again = download_ticket(&origin, &format!("{origin}/content/t1"), &downloads).await.unwrap();
    assert_eq!(again, downloads.join("report (1).pdf"));
    assert!(download_ticket(&origin, "http://evil.example/content/t1", &downloads).await.is_err());
    assert!(download_ticket(&origin, &format!("{origin}/api/v1/projects"), &downloads).await.is_err());
    forget_in(dir.path()).unwrap();
    assert!(paired_in(dir.path()).is_none());
    assert!(sign_in(dir.path()).await.is_err());
}

#[test]
fn addresses_and_names_are_strict() {
    assert_eq!(validate_origin("https://Desk.example.ts.net/").unwrap(), "https://desk.example.ts.net");
    for bad in ["http://desk.example", "https://", "https://a/b", "https://u@h", "ftp://x"] {
        assert!(validate_origin(bad).is_err(), "{bad}");
    }
    assert_eq!(host_port("h.example:8443", 443).unwrap(), ("h.example".into(), 8443));
    assert_eq!(host_port("h.example", 443).unwrap(), ("h.example".into(), 443));
    assert_eq!(host_port("[::1]:9", 443).unwrap(), ("::1".into(), 9));
    assert_eq!(file_name_of("attachment; filename=\"a/b\\\\c.txt\""), Some("c.txt".into()));
    assert_eq!(file_name_of("attachment; filename=\"..\""), None);
    assert_eq!(file_name_of("inline"), None);
    // P5 review: nothing Windows reads as a stream, a device or a dropped dot.
    assert_eq!(file_name_of("attachment; filename=\"notes.txt:hidden\""), Some("notes.txt_hidden".into()));
    assert_eq!(file_name_of("attachment; filename=\"CON.txt\""), Some("_CON.txt".into()));
    assert_eq!(file_name_of("attachment; filename=\"com1\""), Some("_com1".into()));
    assert_eq!(file_name_of("attachment; filename=\"report.pdf. \""), Some("report.pdf".into()));
    assert_eq!(file_name_of("attachment; filename=\"...\""), None);
    assert_eq!(file_name_of("attachment; filename=\"compose.yaml\""), Some("compose.yaml".into()));
    for program in ["setup.EXE", "run.bat", "x.ps1", "a.desktop", "b.AppImage", "s.sh", "l.lnk"] {
        assert!(opens_as_program(program), "{program}");
    }
    for document in ["report.pdf", "notes.md", "photo.jpeg", "Makefile", "data.csv"] {
        assert!(!opens_as_program(document), "{document}");
    }
}

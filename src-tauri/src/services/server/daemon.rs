//! The per-user daemon, `tabtivity-serverd` (hosted plan §3.1): the Mobile
//! sidecar's host serving one account on a unix socket the gateway alone may
//! connect to. Everything the sidecar does with no window — the phone API,
//! the browser transport, the headless owner's timers — it does here, as the
//! user's uid, inside the user's slice; nothing of another user is reachable
//! because nothing of another user is this uid's.
//!
//! Started by the unit `tabtivity-serverd@<user>.service` (`src-gateway`'s
//! `units`), which sets the environment [`super::ServerConfig`] reads. Not a
//! daemon in the double-fork sense: systemd is the supervisor.

use std::path::PathBuf;

use super::ServerConfig;
use crate::brand::SLUG;
use crate::services::mobile_control::config::{HostConfig, MobileHostSettings};
use crate::services::mobile_control::host::{self, Listen};

/// `tabtivity-serverd`: the process's whole life. Exits non-zero on a
/// configuration or bind error so `Restart=on-failure` keeps retrying what
/// can heal and the journal says what cannot.
pub fn main() -> ! {
    crate::services::brand_migration::hits::install();
    let state_dir = crate::storage::state_dir();
    let config = match ServerConfig::from_env(state_dir) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("{SLUG}-serverd: {error}");
            std::process::exit(2);
        }
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("{SLUG}-serverd: runtime: {error}");
            std::process::exit(1);
        }
    };
    match runtime.block_on(run(config)) {
        Ok(()) => {
            eprintln!("{SLUG}-serverd: exiting: shut down on admin request");
            std::process::exit(0);
        }
        Err(error) => {
            eprintln!("{SLUG}-serverd: {error}");
            std::process::exit(1);
        }
    }
}

/// Serve `config` until the admin socket asks for a shutdown.
pub async fn run(config: ServerConfig) -> Result<(), String> {
    harden_process();
    let host = host_config(&config)?;
    let listen = Listen::Unix {
        path: config.socket_path.clone(),
        peer_uid: config.gateway_uid,
        content_origin: config.content_origin.clone(),
    };
    eprintln!(
        "{SLUG}-serverd: serving {} on {} for the gateway{}",
        config.origin,
        config.socket_path.display(),
        config.gateway_uid.map(|uid| format!(" (uid {uid})")).unwrap_or_default()
    );
    host::run_with(host, listen).await
}

/// The sidecar's configuration for a daemon: Mobile on, the gateway's origin
/// as what devices sign, the browser client on, the port a formality (nothing
/// listens on it; `Listen::Unix` decides). `settings.json` is not consulted
/// for any of it — the account's own settings cannot switch its daemon off.
pub fn host_config(config: &ServerConfig) -> Result<HostConfig, String> {
    let control_dir = config.state_dir.join("mobile-control");
    Ok(HostConfig {
        state_dir: config.state_dir.clone(),
        control_dir,
        host: MobileHostSettings {
            enabled: true,
            display_name: String::new(),
            port: 0,
            serve_origin: Some(config.origin.clone()),
            stay_after_quit: Some(true),
            browser_client: Some(true),
        },
        origin: config.origin.clone(),
    })
}

/// `PR_SET_DUMPABLE = 0` (plan §6.8): other processes of this uid — the
/// user's own shells and agents — cannot `ptrace` or read `/proc/<pid>/mem`
/// of the daemon, which holds the unlocked secrets key. Best effort: a kernel
/// that refuses leaves the deployment check (`prereq`) to say so.
fn harden_process() {
    #[cfg(target_os = "linux")]
    // SAFETY: prctl with PR_SET_DUMPABLE and an integer argument reads no
    // memory; the remaining arguments are unused for this option.
    unsafe {
        libc::prctl(libc::PR_SET_DUMPABLE, 0 as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong);
    }
}

/// Where a user's daemon socket lives by convention: `/run/<slug>/users/<uid>.sock`.
pub fn socket_path_for(uid: u32) -> PathBuf {
    PathBuf::from("/run").join(SLUG).join("users").join(format!("{uid}.sock"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use base64ct::{Base64UrlUnpadded, Encoding};
    use p256::ecdsa::{signature::Signer, Signature, SigningKey};
    use p256::pkcs8::EncodePublicKey;
    use serde_json::{json, Value};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::UnixStream;

    use crate::services::mobile_control::auth;

    const ORIGIN: &str = "https://desk.example.ts.net";

    /// One HTTP/1.1 request over the daemon's socket, `Connection: close`.
    async fn raw(socket: &std::path::Path, method: &str, path: &str, headers: &[(&str, &str)], body: Option<&str>) -> (u16, Vec<(String, String)>, String) {
        let mut stream = UnixStream::connect(socket).await.expect("connect");
        let mut request = format!("{method} {path} HTTP/1.1\r\nHost: desk.example.ts.net\r\nConnection: close\r\n");
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
        let status: u16 = lines.next().and_then(|l| l.split_whitespace().nth(1)).and_then(|s| s.parse().ok()).unwrap_or(0);
        let headers = lines.filter_map(|l| l.split_once(": ").map(|(k, v)| (k.to_ascii_lowercase(), v.to_string()))).collect();
        (status, headers, body.to_string())
    }

    fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
        headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }

    /// The daemon end to end on a unix socket: the invite the helper wrote
    /// enrols a device, the device signs the daemon's nonce, and the browser
    /// transport serves that session with the role the gateway names — the
    /// token link is not needed, and the `Host`/`Origin` are the gateway's.
    #[tokio::test]
    async fn the_daemon_serves_a_device_enrolled_by_invite_with_the_gateway_role() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message as WsMessage};
        let dir = tempfile::tempdir().unwrap();
        let state_dir = dir.path().join("state");
        std::fs::create_dir_all(&state_dir).unwrap();
        let socket = dir.path().join("d.sock");
        let config = ServerConfig {
            state_dir: state_dir.clone(),
            socket_path: socket.clone(),
            gateway_uid: None,
            origin: ORIGIN.into(),
            content_origin: Some(format!("{ORIGIN}:8443")),
        };
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
        auth::write_invite(&state_dir.join("mobile-control"), "12345678", now + 600).unwrap();
        tokio::spawn(async move {
            if let Err(error) = run(config).await {
                eprintln!("daemon: {error}");
            }
        });
        for _ in 0..200 {
            if socket.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let (status, _, body) = raw(&socket, "GET", "/healthz", &[], None).await;
        assert_eq!(status, 200, "{body}");
        // The browser shell asks for a sign-in; through another host nothing exists.
        let (status, _, _) = raw(&socket, "GET", "/desktop/", &[], None).await;
        assert_eq!(status, 401);
        let mut other = UnixStream::connect(&socket).await.unwrap();
        other.write_all(b"GET /desktop/ HTTP/1.1\r\nHost: other.example\r\nConnection: close\r\n\r\n").await.unwrap();
        let mut bytes = Vec::new();
        other.read_to_end(&mut bytes).await.unwrap();
        assert!(String::from_utf8_lossy(&bytes).starts_with("HTTP/1.1 404"));

        // Enrol with the invite (a wrong code first: a miss, not a lockout).
        let signing = SigningKey::random(&mut rand::rngs::OsRng);
        let public_key = Base64UrlUnpadded::encode_string(signing.verifying_key().to_public_key_der().unwrap().as_bytes());
        let pair = |code: &str| json!({ "code": code, "device_name": "Laptop", "public_key": public_key }).to_string();
        let (status, _, body) = raw(&socket, "POST", "/api/v1/pair", &[("Origin", ORIGIN)], Some(&pair("00000000"))).await;
        assert_eq!(status, 400, "{body}");
        let (status, _, body) = raw(&socket, "POST", "/api/v1/pair", &[("Origin", ORIGIN)], Some(&pair("12345678"))).await;
        assert_eq!(status, 201, "{body}");
        let device_id = serde_json::from_str::<Value>(&body).unwrap()["device_id"].as_str().unwrap().to_string();
        assert!(!state_dir.join("mobile-control").join(auth::INVITE_FILE).exists(), "the invite is spent");
        let (status, _, body) = raw(&socket, "POST", "/api/v1/pair", &[("Origin", ORIGIN)], Some(&pair("12345678"))).await;
        assert_eq!(status, 400, "a spent invite enrols nothing: {body}");

        // Sign the daemon's nonce.
        let (status, _, body) = raw(&socket, "POST", "/api/v1/auth/challenge", &[("Origin", ORIGIN)], Some(&json!({ "device_id": device_id }).to_string())).await;
        assert_eq!(status, 200, "{body}");
        let challenge: Value = serde_json::from_str(&body).unwrap();
        let signature: Signature = signing.sign(challenge["payload"].as_str().unwrap().as_bytes());
        let session = json!({ "device_id": device_id, "nonce": challenge["nonce"], "signature": Base64UrlUnpadded::encode_string(&signature.to_bytes()) }).to_string();
        let (status, headers, body) = raw(&socket, "POST", "/api/v1/auth/session", &[("Origin", ORIGIN)], Some(&session)).await;
        assert_eq!(status, 200, "{body}");
        let cookie = header(&headers, "set-cookie").unwrap().split(';').next().unwrap().to_string();
        assert!(cookie.starts_with("__Host-"), "{cookie}");

        // The device session signs the browser shell in.
        let (status, headers, body) = raw(&socket, "GET", "/desktop/", &[("Cookie", &cookie)], None).await;
        assert_eq!(status, 200, "{body}");
        assert!(body.contains("web:bundle"), "no bundle in a test → the not-built page");
        assert!(header(&headers, "content-security-policy").unwrap().contains("wss://desk.example.ts.net"), "{headers:?}");

        // The socket: the role is the gateway's header, a user by default.
        let open = |role: Option<&str>| {
            let mut request = "ws://desk.example.ts.net/api/v1/desktop/ws".into_client_request().unwrap();
            request.headers_mut().insert("cookie", cookie.parse().unwrap());
            request.headers_mut().insert("origin", ORIGIN.parse().unwrap());
            request.headers_mut().insert("sec-websocket-protocol", crate::brand::DESKTOP_PROTOCOL.parse().unwrap());
            if let Some(role) = role {
                request.headers_mut().insert(super::super::ROLE_HEADER, role.parse().unwrap());
            }
            request
        };
        let stream = UnixStream::connect(&socket).await.unwrap();
        let (mut ws, _) = tokio_tungstenite::client_async(open(None), stream).await.expect("upgrade");
        let hello: Value = match ws.next().await.unwrap().unwrap() {
            WsMessage::Text(t) => serde_json::from_str(&t).unwrap(),
            other => panic!("{other:?}"),
        };
        assert_eq!(hello["capabilities"]["role"], "user");
        // A ticket names the user-content origin; an admin command is refused.
        ws.send(WsMessage::Text(json!({ "t": "call", "id": 1, "cmd": "install_ollama" }).to_string().into())).await.unwrap();
        if let WsMessage::Text(t) = ws.next().await.unwrap().unwrap() {
            let v: Value = serde_json::from_str(&t).unwrap();
            assert_eq!(v["err"]["code"], "admin", "{v}");
        }
        ws.close(None).await.unwrap();
        let stream = UnixStream::connect(&socket).await.unwrap();
        let (mut ws, _) = tokio_tungstenite::client_async(open(Some("admin")), stream).await.expect("upgrade");
        let hello: Value = match ws.next().await.unwrap().unwrap() {
            WsMessage::Text(t) => serde_json::from_str(&t).unwrap(),
            other => panic!("{other:?}"),
        };
        assert_eq!(hello["capabilities"]["role"], "admin");
        ws.send(WsMessage::Text(json!({ "t": "call", "id": 2, "cmd": crate::services::mobile_control::web_client::FILE_TICKET_CMD, "args": { "path": "/tmp/x.pdf" } }).to_string().into())).await.unwrap();
        if let WsMessage::Text(t) = ws.next().await.unwrap().unwrap() {
            let v: Value = serde_json::from_str(&t).unwrap();
            assert!(v["ok"]["url"].as_str().unwrap().starts_with("https://desk.example.ts.net:8443/content/"), "{v}");
        }
        ws.close(None).await.unwrap();
        // The socket's Origin must be the gateway's, not a loopback one.
        let mut request = open(None);
        request.headers_mut().insert("origin", "http://127.0.0.1:8742".parse().unwrap());
        let stream = UnixStream::connect(&socket).await.unwrap();
        assert!(tokio_tungstenite::client_async(request, stream).await.is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&socket).unwrap().permissions().mode() & 0o777, 0o660);
        }
    }

    /// A connection from another uid is dropped before a byte is read.
    #[tokio::test]
    async fn another_uid_is_refused_at_accept() {
        use crate::services::mobile_control::limits::PeerGatedUnixListener;
        // SAFETY: getuid has no preconditions.
        let own = unsafe { libc::getuid() };
        assert!(PeerGatedUnixListener::allows(None, own));
        assert!(PeerGatedUnixListener::allows(Some(own), own));
        assert!(!PeerGatedUnixListener::allows(Some(own.wrapping_add(1)), own));
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("gated.sock");
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        let gated = PeerGatedUnixListener::new(listener, Some(own.wrapping_add(1)));
        let refused = gated.refused_counter();
        let app = axum::Router::new().route("/healthz", axum::routing::get(|| async { "ok" }));
        tokio::spawn(async move { axum::serve(gated, app).await.unwrap() });
        let mut stream = UnixStream::connect(&path).await.unwrap();
        stream.write_all(b"GET /healthz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").await.unwrap();
        let mut bytes = Vec::new();
        // Closed or reset, either way nothing was answered.
        let _ = tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut bytes)).await.expect("the server closes");
        assert!(bytes.is_empty(), "nothing is answered: {:?}", String::from_utf8_lossy(&bytes));
        assert_eq!(refused.load(std::sync::atomic::Ordering::Relaxed), 1);
    }

    #[test]
    fn the_host_config_is_the_gateway_origin_with_mobile_and_the_browser_on() {
        let config = ServerConfig {
            state_dir: PathBuf::from("/home/alice/.local/share/x"),
            socket_path: PathBuf::from("/run/x/users/1001.sock"),
            gateway_uid: Some(998),
            origin: "https://desk.example.ts.net".into(),
            content_origin: None,
        };
        let host = host_config(&config).unwrap();
        assert!(host.host.enabled);
        assert_eq!(host.host.browser_client, Some(true));
        assert_eq!(host.origin, "https://desk.example.ts.net");
        assert_eq!(host.control_dir, PathBuf::from("/home/alice/.local/share/x/mobile-control"));
        assert_eq!(socket_path_for(1001), PathBuf::from("/run").join(SLUG).join("users/1001.sock"));
    }
}

//! Connect to a server (hosted plan §7.2, P5): the desktop app as a client of
//! a Tabtivity server, beside its own standalone workspace (Q12).
//!
//! A **Connect** window runs the app's own frontend — from this binary, never
//! code the server sends — with the browser client's transport: every `core`
//! command goes over the server's desktop socket, `client` commands stay on
//! this machine (native clipboard, notifications, window controls, open after
//! a download). The socket itself is opened here, in Rust, and its frames are
//! bridged to that window (`commands::connect`), because the window's own
//! origin is the app's, not the server's: the server's session cookie is
//! `SameSite=Strict` and its socket checks the exact `Origin`.
//!
//! * **Pairing** is the browser's: an invite code (`user:digits`) pairs a
//!   P-256 key generated here, kept in `<state>/connect/device.key` (`0600`,
//!   PKCS#8 — like the daemon's identity key; fenced agents never see the
//!   state dir). The server's daemon stores the public half like any device.
//! * **Sign-in** per socket: challenge → the payload signed (raw `r‖s`, as
//!   WebCrypto signs) → session; the answer's cookies (the daemon's session
//!   and the gateway's routing cookie) ride the socket's upgrade with the
//!   server's own `Origin` and the desktop subprotocol.
//! * **AppHandle-free**: window and events are `commands::connect`'s.

use std::path::{Path, PathBuf};

use base64ct::{Base64UrlUnpadded, Encoding};
use serde::{Deserialize, Serialize};

pub const DIR: &str = "connect";
const CONFIG_FILE: &str = "connect.json";
const KEY_FILE: &str = "device.key";
/// The socket path on the server (`web_client.rs`).
pub const SOCKET_PATH: &str = "/api/v1/desktop/ws";

/// The server this desktop is paired with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Paired {
    pub origin: String,
    pub device_id: String,
    pub device_name: String,
}

pub fn dir_in(state_dir: &Path) -> PathBuf {
    state_dir.join(DIR)
}

/// The pairing, when there is one and its key is there.
pub fn paired_in(state_dir: &Path) -> Option<Paired> {
    let dir = dir_in(state_dir);
    if !dir.join(KEY_FILE).is_file() {
        return None;
    }
    let bytes = std::fs::read(dir.join(CONFIG_FILE)).ok()?;
    serde_json::from_slice::<Paired>(&bytes).ok().filter(|p| validate_origin(&p.origin).is_ok())
}

/// Forget the server: the key and the record go (the server keeps the
/// device until it is revoked there).
pub fn forget_in(state_dir: &Path) -> Result<(), String> {
    let dir = dir_in(state_dir);
    for leaf in [KEY_FILE, CONFIG_FILE] {
        match std::fs::remove_file(dir.join(leaf)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(format!("{leaf}: {e}")),
            _ => {}
        }
    }
    Ok(())
}

/// `https://host[:port]`, nothing else (no path, credentials, query); tests
/// may use plain loopback HTTP.
pub fn validate_origin(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim().trim_end_matches('/');
    #[cfg(test)]
    if trimmed.starts_with("http://127.0.0.1:") {
        return Ok(trimmed.to_string());
    }
    let rest = trimmed.strip_prefix("https://").ok_or("the server's address must start with https://")?;
    if rest.is_empty() || rest.contains(['/', '@', '?', '#']) || !rest.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b':' | b'[' | b']')) {
        return Err("the server's address is https://host or https://host:port".into());
    }
    Ok(trimmed.to_ascii_lowercase())
}

fn client() -> Result<reqwest::Client, String> {
    crate::services::mail_engine::install_crypto_provider();
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())
}

/// POST JSON to the server as its own page would (exact `Origin`).
async fn post(origin: &str, path: &str, body: serde_json::Value) -> Result<(serde_json::Value, Vec<String>), String> {
    let answer = client()?
        .post(format!("{origin}{path}"))
        .header("origin", origin)
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("the server did not answer: {}", e.without_url()))?;
    let status = answer.status();
    let cookies: Vec<String> = answer.headers().get_all("set-cookie").iter().filter_map(|v| v.to_str().ok()).filter_map(|v| v.split(';').next()).map(|v| v.trim().to_string()).collect();
    let value: serde_json::Value = answer.bytes().await.ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(serde_json::Value::Null);
    if !status.is_success() {
        let code = value.get("error").and_then(|v| v.as_str()).unwrap_or("refused");
        return Err(format!("the server refused: {code}"));
    }
    Ok((value, cookies))
}

/// Pair this desktop with `origin` by an invite code (`user:digits`): a new
/// key, its public half sent with the code, the record kept.
pub async fn pair_in(state_dir: &Path, origin: &str, code: &str, device_name: &str) -> Result<Paired, String> {
    use p256::pkcs8::{EncodePrivateKey, EncodePublicKey};
    let origin = validate_origin(origin)?;
    let code = code.trim();
    let name = device_name.trim();
    if code.is_empty() || name.is_empty() {
        return Err("an invite code and a name for this computer are needed".into());
    }
    let key = p256::ecdsa::SigningKey::random(&mut rand::rngs::OsRng);
    let public = key.verifying_key().to_public_key_der().map_err(|e| e.to_string())?;
    let body = serde_json::json!({ "code": code, "device_name": name, "public_key": Base64UrlUnpadded::encode_string(public.as_bytes()) });
    let (answer, _) = post(&origin, "/api/v1/pair", body).await?;
    let device_id = answer.get("device_id").and_then(|v| v.as_str()).filter(|d| (8..=128).contains(&d.len()) && d.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')).ok_or("the server answered no device id")?.to_string();
    let dir = dir_in(state_dir);
    crate::services::agent_home::create_private_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let der = key.to_pkcs8_der().map_err(|e| e.to_string())?;
    write_private(&dir.join(KEY_FILE), der.as_bytes())?;
    let paired = Paired { origin, device_id, device_name: name.chars().take(64).collect() };
    crate::services::mobile_control::store::write_json_atomic(&dir.join(CONFIG_FILE), &paired, 0o600)?;
    Ok(paired)
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let tmp = path.with_extension("tmp");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
    file.write_all(bytes).and_then(|()| file.sync_all()).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
}

fn signing_key(state_dir: &Path) -> Result<p256::ecdsa::SigningKey, String> {
    use p256::pkcs8::DecodePrivateKey;
    let der = zeroize::Zeroizing::new(std::fs::read(dir_in(state_dir).join(KEY_FILE)).map_err(|_| "this computer is not paired with a server")?);
    p256::ecdsa::SigningKey::from_pkcs8_der(&der).map_err(|_| "the pairing key is unreadable; pair again".to_string())
}

/// A signed-in session: the cookies the socket's upgrade carries.
#[derive(Clone)]
pub struct Session {
    pub origin: String,
    pub cookies: String,
}

impl std::fmt::Debug for Session {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Session").field("origin", &self.origin).finish_non_exhaustive()
    }
}

/// Sign in with the paired key (challenge → signed payload → session).
pub async fn sign_in(state_dir: &Path) -> Result<Session, String> {
    use p256::ecdsa::signature::Signer;
    let paired = paired_in(state_dir).ok_or("this computer is not paired with a server")?;
    let key = signing_key(state_dir)?;
    let (challenge, _) = post(&paired.origin, "/api/v1/auth/challenge", serde_json::json!({ "device_id": paired.device_id })).await?;
    let (Some(nonce), Some(payload)) = (challenge.get("nonce").and_then(|v| v.as_str()), challenge.get("payload").and_then(|v| v.as_str())) else {
        return Err("the server's challenge is malformed".into());
    };
    let signature: p256::ecdsa::Signature = key.sign(payload.as_bytes());
    let body = serde_json::json!({ "device_id": paired.device_id, "nonce": nonce, "signature": Base64UrlUnpadded::encode_string(&signature.to_bytes()) });
    let (_, cookies) = post(&paired.origin, "/api/v1/auth/session", body).await?;
    if cookies.is_empty() {
        return Err("the server set no session".into());
    }
    Ok(Session { origin: paired.origin, cookies: cookies.join("; ") })
}

/// Anything the socket can run over: TLS to a server, plain TCP in tests.
pub trait Io: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send {}
impl<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send> Io for T {}

pub type Socket = tokio_tungstenite::WebSocketStream<Box<dyn Io>>;

/// Open the server's desktop socket for `session` (`resume`: the client id a
/// reconnect keeps).
pub async fn open_socket(session: &Session, resume: Option<&str>) -> Result<Socket, String> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let (secure, authority) = match session.origin.split_once("://") {
        Some(("https", rest)) => (true, rest.to_string()),
        Some(("http", rest)) if cfg!(test) => (false, rest.to_string()),
        _ => return Err("not an https server".into()),
    };
    let (host, port) = host_port(&authority, if secure { 443 } else { 80 })?;
    let tcp = tokio::net::TcpStream::connect((host.as_str(), port)).await.map_err(|e| format!("{host}:{port}: {e}"))?;
    let stream: Box<dyn Io> = if secure {
        let name = rustls_pki_types::ServerName::try_from(host.clone()).map_err(|e| e.to_string())?;
        let tls = tokio_rustls::TlsConnector::from(crate::services::mail_engine::tls_config()).connect(name, tcp).await.map_err(|e| format!("TLS: {e}"))?;
        Box::new(tls)
    } else {
        Box::new(tcp)
    };
    let scheme = if secure { "wss" } else { "ws" };
    let mut url = format!("{scheme}://{authority}{SOCKET_PATH}");
    if let Some(resume) = resume.filter(|r| r.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') && !r.is_empty()) {
        url.push_str("?resume=");
        url.push_str(resume);
    }
    let mut request = url.into_client_request().map_err(|e| e.to_string())?;
    let headers = request.headers_mut();
    headers.insert("origin", session.origin.parse().map_err(|_| "origin")?);
    headers.insert("cookie", session.cookies.parse().map_err(|_| "cookie")?);
    headers.insert("sec-websocket-protocol", crate::brand::DESKTOP_PROTOCOL.parse().map_err(|_| "protocol")?);
    let (socket, _) = tokio_tungstenite::client_async(request, stream).await.map_err(|e| format!("the server's socket: {e}"))?;
    Ok(socket)
}

/// `host[:port]` or `[v6][:port]` → host (no brackets) and port.
fn host_port(authority: &str, default: u16) -> Result<(String, u16), String> {
    let parse = |p: &str| p.parse::<u16>().map_err(|_| format!("bad port in {authority}"));
    if let Some(rest) = authority.strip_prefix('[') {
        let (host, after) = rest.split_once(']').ok_or("bad address")?;
        let port = match after.strip_prefix(':') {
            Some(p) => parse(p)?,
            None if after.is_empty() => default,
            None => return Err(format!("bad address {authority}")),
        };
        return Ok((host.to_string(), port));
    }
    match authority.split_once(':') {
        Some((host, p)) => Ok((host.to_string(), parse(p)?)),
        None => Ok((authority.to_string(), default)),
    }
}

/// Download `url` — a ticket on the server's user-content origin (same host
/// as the server, https) — into `dir` under `name`'s last component, for
/// opening on this machine ("open outside after a download", §7.2).
pub async fn download_ticket(origin: &str, url: &str, dir: &Path) -> Result<PathBuf, String> {
    let host = origin.split_once("://").and_then(|(_, r)| host_port(r, 443).ok()).map(|(h, _)| h).unwrap_or_default();
    let parsed = url::Url::parse(url).map_err(|_| "not a URL")?;
    let same_host = parsed.host_str() == Some(host.as_str());
    let allowed_scheme = parsed.scheme() == "https" || (cfg!(test) && parsed.scheme() == "http");
    if !same_host || !allowed_scheme || !parsed.path().starts_with("/content/") {
        return Err("refusing to download from anywhere but the server's content address".into());
    }
    let answer = client()?.get(parsed.clone()).send().await.map_err(|e| format!("download: {}", e.without_url()))?;
    if !answer.status().is_success() {
        return Err(format!("download: HTTP {}", answer.status().as_u16()));
    }
    let disposition = answer.headers().get("content-disposition").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let bytes = answer.bytes().await.map_err(|e| format!("download: {}", e.without_url()))?;
    let name = file_name_of(&disposition).unwrap_or_else(|| "download".into());
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let path = unique(dir, &name);
    std::fs::write(&path, &bytes).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(path)
}

/// The file name a `Content-Disposition` names, cut to its last component
/// and stripped of anything that could leave the download folder — or, on
/// Windows, name a stream (`a:b`), a device (`CON`) or lose a trailing dot.
pub fn file_name_of(disposition: &str) -> Option<String> {
    let raw = disposition.split(';').map(str::trim).find_map(|p| p.strip_prefix("filename=")).map(|v| v.trim_matches('"').to_string())?;
    let leaf = raw.rsplit(['/', '\\']).next().unwrap_or("").trim().to_string();
    let clean: String = leaf.chars().filter(|c| !c.is_control()).map(|c| if matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') { '_' } else { c }).collect();
    let clean = clean.trim_end_matches(['.', ' ']).to_string();
    if clean.is_empty() {
        return None;
    }
    let stem = clean.split('.').next().unwrap_or("").to_ascii_uppercase();
    let device = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL") || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.as_bytes()[3].is_ascii_digit());
    Some(if device { format!("_{clean}") } else { clean })
}

/// Would the system's default app *run* a file of this name rather than
/// show it? Such a download is kept but not opened: the server — or a
/// co-member of a shared project — named it, and on Windows a downloaded
/// `.exe` or `.bat` opened "with its default app" is a program started.
pub fn opens_as_program(name: &str) -> bool {
    const PROGRAMS: &[&str] = &[
        "exe", "com", "bat", "cmd", "scr", "pif", "msi", "msp", "msc", "cpl", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "hta", "lnk", "url", "scf", "reg", "inf", "jar",
        "application", "appref-ms", "gadget", "appimage", "desktop", "sh", "bash", "zsh", "csh", "run", "bin", "command", "app", "pkg", "dmg", "mpkg", "deb", "rpm", "flatpakref", "py", "pyw", "pl", "rb",
    ];
    name.rsplit_once('.').is_some_and(|(_, ext)| PROGRAMS.contains(&ext.to_ascii_lowercase().as_str()))
}

/// May a downloaded server file be opened with the system's default app?
/// An allowlist of inert viewer types (final review A4): documents, pictures
/// and plain text whose usual viewers show them and run nothing. Anything
/// else — a program, but also an extension no list foresaw (`.terminal`,
/// `.fileloc`, `.library-ms`, `.iso`, an extensionless script some file
/// managers offer to run) — is only shown in its folder: the server, or a
/// co-member of a shared project, chose its name. Legacy Office formats
/// (`.doc`/`.xls`/`.ppt`) and SVG/HTML stay out: they carry macros or script.
pub fn opens_as_inert_viewer(name: &str) -> bool {
    const INERT: &[&str] = &[
        "pdf", "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic", "avif", "txt", "md", "csv", "tsv", "log", "json", "yaml", "yml", "toml",
        "docx", "xlsx", "pptx", "odt", "ods", "odp", "rtf", "mp3", "wav", "ogg", "flac", "mp4", "webm", "mkv", "mov",
    ];
    if opens_as_program(name) {
        return false;
    }
    name.rsplit_once('.').is_some_and(|(stem, ext)| !stem.is_empty() && INERT.contains(&ext.to_ascii_lowercase().as_str()))
}

/// Windows: give a downloaded server file the Mark of the Web (an NTFS
/// `Zone.Identifier` stream, Internet zone), as a browser download gets, so
/// SmartScreen and Office's Protected View treat it as from the internet.
/// Best effort: a FAT drive has no streams.
#[cfg(windows)]
pub fn mark_of_the_web(path: &Path, origin: &str) {
    let mut stream = path.as_os_str().to_owned();
    stream.push(":Zone.Identifier");
    let _ = std::fs::write(PathBuf::from(stream), format!("[ZoneTransfer]\r\nZoneId=3\r\nHostUrl={origin}\r\n"));
}

fn unique(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    (1..1000).map(|n| dir.join(format!("{stem} ({n}){ext}"))).find(|p| !p.exists()).unwrap_or(first)
}

#[cfg(test)]
mod tests;

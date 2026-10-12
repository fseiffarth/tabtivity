//! Finishes an agent CLI's browser sign-in that was started from the phone.
//!
//! Most CLIs sign in through OAuth with a redirect to a server they run on
//! this machine (`http://localhost:1455/auth/callback?code=…&state=…` for
//! Codex, Gemini's `/oauth2callback`, …). Opened on the phone, that redirect
//! lands on the *phone's* localhost and fails — but the address the phone's
//! browser ended on still carries the one-time code. The phone pastes it, and
//! the sidecar delivers it here, to the listener the CLI is waiting on. The
//! agent fence shares the host's network namespace, so a fenced tab's
//! listener is reachable exactly as an unfenced one's.
//!
//! What this will fetch is deliberately narrow, since the address comes from a
//! paired phone and not from the CLI: plain `http` to a loopback host, an
//! explicit unprivileged port that is not the sidecar's own, no credentials,
//! and a query carrying an OAuth answer (`state` plus `code` or `error`). One
//! GET, no proxy, no redirects followed, and nothing of the answer but its
//! status goes back — so it cannot read another local service's pages, only
//! hand a code to whatever is listening. AppHandle-free and unit-testable.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

/// The longest address accepted. OAuth codes run to a few hundred bytes;
/// Antigravity notes providers that send codes past 1 KiB.
pub const MAX_CALLBACK_URL: usize = 8 * 1024;
/// How long the CLI gets to answer. It exchanges the code with its provider
/// before replying, so this is a network round trip, not a local one.
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(20);

/// A callback address that passed [`parse_callback`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Callback {
    /// Where to connect: a loopback address, never a name.
    pub targets: Vec<SocketAddr>,
    /// Path and query, sent as they were pasted.
    pub path_and_query: String,
}

/// Why an address was refused, as the phone's error code.
pub fn parse_callback(raw: &str, own_port: u16) -> Result<Callback, &'static str> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > MAX_CALLBACK_URL {
        return Err("invalid_callback");
    }
    let url = url::Url::parse(raw).map_err(|_| "invalid_callback")?;
    if url.scheme() != "http" || !url.username().is_empty() || url.password().is_some() {
        return Err("invalid_callback");
    }
    let ips: Vec<IpAddr> = match url.host() {
        Some(url::Host::Domain(name)) if name.eq_ignore_ascii_case("localhost") => {
            // Resolved here, not by the system: `localhost` is whichever
            // loopback the CLI bound, and no hosts file gets a say.
            vec![IpAddr::V4(Ipv4Addr::LOCALHOST), IpAddr::V6(Ipv6Addr::LOCALHOST)]
        }
        Some(url::Host::Ipv4(ip)) if ip.is_loopback() => vec![IpAddr::V4(ip)],
        Some(url::Host::Ipv6(ip)) if ip.is_loopback() => vec![IpAddr::V6(ip)],
        _ => return Err("callback_not_local"),
    };
    let Some(port) = url.port() else {
        return Err("invalid_callback");
    };
    if port < 1024 || port == own_port {
        return Err("callback_not_local");
    }
    let mut state = false;
    let mut answer = false;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "state" if !value.is_empty() => state = true,
            "code" | "error" if !value.is_empty() => answer = true,
            _ => {}
        }
    }
    if !state || !answer {
        return Err("callback_without_code");
    }
    let mut path_and_query = url.path().to_string();
    if let Some(query) = url.query() {
        path_and_query.push('?');
        path_and_query.push_str(query);
    }
    Ok(Callback {
        targets: ips.into_iter().map(|ip| SocketAddr::new(ip, port)).collect(),
        path_and_query,
    })
}

/// The loopback TCP listeners in a `/proc/net/tcp{,6}` table: `(address,
/// port, uid)` of every socket in `LISTEN` (`0A`).
pub fn listeners(table: &str) -> Vec<(IpAddr, u16, u32)> {
    fn ip_of(hex: &str) -> Option<IpAddr> {
        // The kernel prints each 32-bit word in host (little-endian) order.
        let words: Vec<u32> = (0..hex.len() / 8).map(|i| u32::from_str_radix(&hex[i * 8..i * 8 + 8], 16).ok()).collect::<Option<_>>()?;
        match words.as_slice() {
            [w] => Some(IpAddr::V4(Ipv4Addr::from(w.to_le_bytes()))),
            [a, b, c, d] => {
                let mut bytes = [0u8; 16];
                for (i, w) in [a, b, c, d].iter().enumerate() {
                    bytes[i * 4..i * 4 + 4].copy_from_slice(&w.to_le_bytes());
                }
                Some(IpAddr::V6(Ipv6Addr::from(bytes)))
            }
            _ => None,
        }
    }
    table
        .lines()
        .skip(1)
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() < 8 || fields[3] != "0A" {
                return None;
            }
            let (addr, port) = fields[1].split_once(':')?;
            Some((ip_of(addr)?, u16::from_str_radix(port, 16).ok()?, fields[7].parse().ok()?))
        })
        .collect()
}

/// The callback's targets whose listener belongs to `uid` (hosted plan
/// §5.1): on a server every user shares the loopback, so the relay hands a
/// code only to a listener of the caller's own uid — never to another
/// user's. A listener on the unspecified address counts for its family.
pub fn own_targets(callback: &Callback, uid: u32, tables: &[String]) -> Vec<SocketAddr> {
    let listening: Vec<(IpAddr, u16, u32)> = tables.iter().flat_map(|t| listeners(t)).collect();
    callback
        .targets
        .iter()
        .copied()
        .filter(|target| {
            listening.iter().any(|(ip, port, owner)| {
                *owner == uid && *port == target.port() && (*ip == target.ip() || (ip.is_unspecified() && ip.is_ipv4() == target.is_ipv4()))
            })
        })
        .collect()
}

/// Whether the CLI took the answer: any 2xx or 3xx (Codex redirects to its
/// success page). A 4xx/5xx is the CLI saying no — a stale or reused code.
/// On a server only a listener of this daemon's own uid is ever contacted.
pub async fn deliver(callback: &Callback) -> Result<u16, &'static str> {
    #[cfg(unix)]
    let restricted;
    #[cfg(unix)]
    let callback = if crate::services::server::is_server() {
        let tables: Vec<String> = ["/proc/net/tcp", "/proc/net/tcp6"].iter().filter_map(|p| std::fs::read_to_string(p).ok()).collect();
        // SAFETY: getuid has no preconditions.
        let targets = own_targets(callback, unsafe { libc::getuid() }, &tables);
        if targets.is_empty() {
            return Err("callback_not_yours");
        }
        restricted = Callback { targets, path_and_query: callback.path_and_query.clone() };
        &restricted
    } else {
        callback
    };
    // Plain http only, but reqwest builds its TLS half regardless.
    crate::services::mail_engine::install_crypto_provider();
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(3))
        .timeout(CALLBACK_TIMEOUT)
        .pool_max_idle_per_host(0)
        .build()
        .map_err(|_| "callback_unreachable")?;
    for target in &callback.targets {
        let host = match target.ip() {
            IpAddr::V4(ip) => ip.to_string(),
            IpAddr::V6(ip) => format!("[{ip}]"),
        };
        let url = format!("http://{host}:{}{}", target.port(), callback.path_and_query);
        let response = match client.get(&url).send().await {
            Ok(response) => response,
            // Not listening on this loopback: try the other one.
            Err(error) if error.is_connect() => continue,
            Err(error) if error.is_timeout() => return Err("callback_timeout"),
            Err(_) => return Err("callback_unreachable"),
        };
        let status = response.status();
        // The body is the CLI's page for a browser; it stays here.
        drop(response);
        return if status.is_success() || status.is_redirection() {
            Ok(status.as_u16())
        } else {
            Err("callback_refused")
        };
    }
    Err("callback_unreachable")
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWN: u16 = 8742;

    #[test]
    fn accepts_a_loopback_oauth_answer() {
        let callback = parse_callback("http://localhost:1455/auth/callback?code=abc&state=xyz", OWN).unwrap();
        assert_eq!(callback.path_and_query, "/auth/callback?code=abc&state=xyz");
        assert_eq!(callback.targets.len(), 2);
        assert!(callback.targets.iter().all(|t| t.ip().is_loopback() && t.port() == 1455));
        let v4 = parse_callback(" http://127.0.0.1:40123/oauth2callback?state=s&code=4%2F0A ", OWN).unwrap();
        assert_eq!(v4.targets, vec!["127.0.0.1:40123".parse().unwrap()]);
        assert!(parse_callback("http://[::1]:5000/cb?state=s&error=access_denied", OWN).is_ok());
    }

    #[test]
    fn refuses_anything_that_is_not_a_local_oauth_answer() {
        for (raw, code) in [
            ("https://localhost:1455/cb?code=a&state=b", "invalid_callback"),
            ("http://user:pw@localhost:1455/cb?code=a&state=b", "invalid_callback"),
            ("http://localhost/cb?code=a&state=b", "invalid_callback"),
            ("http://example.com:1455/cb?code=a&state=b", "callback_not_local"),
            ("http://192.0.2.1:1455/cb?code=a&state=b", "callback_not_local"),
            ("http://localhost.example.com:1455/cb?code=a&state=b", "callback_not_local"),
            ("http://localhost:631/cb?code=a&state=b", "callback_not_local"),
            ("http://localhost:8742/cb?code=a&state=b", "callback_not_local"),
            ("http://localhost:1455/cb?code=a", "callback_without_code"),
            ("http://localhost:1455/cb?state=b", "callback_without_code"),
            ("http://localhost:1455/cb?code=&state=b", "callback_without_code"),
            ("not a url", "invalid_callback"),
            ("", "invalid_callback"),
        ] {
            assert_eq!(parse_callback(raw, OWN), Err(code), "{raw}");
        }
        let long = format!("http://localhost:1455/cb?state=s&code={}", "a".repeat(MAX_CALLBACK_URL));
        assert_eq!(parse_callback(&long, OWN), Err("invalid_callback"));
    }

    #[tokio::test]
    async fn delivers_to_the_listener_and_reports_only_the_status() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0u8; 4096];
            let read = socket.read(&mut request).await.unwrap();
            socket
                .write_all(b"HTTP/1.1 302 Found\r\nLocation: /success\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
            String::from_utf8_lossy(&request[..read]).to_string()
        });
        let callback = parse_callback(&format!("http://localhost:{port}/auth/callback?code=c0de&state=st"), OWN).unwrap();
        assert_eq!(deliver(&callback).await, Ok(302));
        let request = server.await.unwrap();
        assert!(request.starts_with("GET /auth/callback?code=c0de&state=st HTTP/1.1"), "{request}");
    }

    #[tokio::test]
    async fn a_refusal_or_no_listener_is_an_error() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0u8; 4096];
            let _ = socket.read(&mut request).await;
            let _ = socket
                .write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await;
        });
        let refused = parse_callback(&format!("http://127.0.0.1:{port}/cb?code=old&state=st"), OWN).unwrap();
        assert_eq!(deliver(&refused).await, Err("callback_refused"));

        let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let dead = closed.local_addr().unwrap().port();
        drop(closed);
        let nobody = parse_callback(&format!("http://127.0.0.1:{dead}/cb?code=c&state=st"), OWN).unwrap();
        assert_eq!(deliver(&nobody).await, Err("callback_unreachable"));
    }

    #[test]
    fn only_the_callers_own_listener_gets_the_code() {
        // 127.0.0.1:1455 (Codex's) of uid 1001, [::1]:1455 of uid 1002,
        // 0.0.0.0:8085 of uid 1001, and a connected (not listening) socket.
        let tcp = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n\
   0: 0100007F:05AF 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 1 1 0000000000000000 100 0 0 10 0\n\
   1: 00000000:1F95 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 2 1 0000000000000000 100 0 0 10 0\n\
   2: 0100007F:0BB8 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1001        0 3 1 0000000000000000 100 0 0 10 0\n".to_string();
        let tcp6 = "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n\
   0: 00000000000000000000000001000000:05AF 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1002        0 4 1 0000000000000000 100 0 0 10 0\n".to_string();
        let found = listeners(&tcp);
        assert!(found.contains(&(IpAddr::V4(Ipv4Addr::LOCALHOST), 1455, 1001)), "{found:?}");
        assert_eq!(found.len(), 2, "the connected socket is no listener");
        assert_eq!(listeners(&tcp6), vec![(IpAddr::V6(Ipv6Addr::LOCALHOST), 1455, 1002)]);
        let tables = [tcp, tcp6];
        let codex = parse_callback("http://localhost:1455/auth/callback?code=c&state=s", OWN).unwrap();
        assert_eq!(own_targets(&codex, 1001, &tables), vec![SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 1455)]);
        assert_eq!(own_targets(&codex, 1002, &tables), vec![SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), 1455)]);
        assert!(own_targets(&codex, 1003, &tables).is_empty(), "nobody else's listener");
        let any = parse_callback("http://127.0.0.1:8085/cb?code=c&state=s", OWN).unwrap();
        assert_eq!(own_targets(&any, 1001, &tables).len(), 1, "an unspecified-address listener counts");
        assert!(own_targets(&any, 1002, &tables).is_empty());
    }
}

//! Forwarding one request to one account's daemon socket (hosted plan §3.1):
//! HTTP/1.1 over the unix socket, WebSocket upgrades spliced end to end.
//!
//! The socket is checked from both sides: the daemon accepts only the
//! gateway's uid (`SO_PEERCRED`, `limits::PeerGatedUnixListener`), and the
//! gateway accepts a daemon end owned by the account's uid — or by root,
//! which is what a socket systemd made for socket activation reports.

use std::path::Path;

use axum::body::Body;
use axum::http::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::net::UnixStream;
use tokio::task::JoinHandle;

#[derive(Debug)]
pub enum ProxyError {
    /// Nothing answered on the socket (the account's socket unit is off).
    Connect(String),
    /// The socket's other end is not the account's.
    Peer { got: u32, want: u32 },
    Http(String),
}

impl std::fmt::Display for ProxyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProxyError::Connect(e) => write!(f, "daemon socket: {e}"),
            ProxyError::Peer { got, want } => write!(f, "daemon socket is uid {got}'s, not {want}'s"),
            ProxyError::Http(e) => write!(f, "daemon: {e}"),
        }
    }
}

/// May a socket whose listening end reports `peer` serve `account`'s uid?
pub fn peer_ok(peer: u32, account: u32) -> bool {
    peer == account || peer == 0
}

/// Connect to `socket` and check whose it is.
pub async fn connect(socket: &Path, uid: u32) -> Result<UnixStream, ProxyError> {
    let stream = UnixStream::connect(socket).await.map_err(|e| ProxyError::Connect(e.to_string()))?;
    let peer = stream.peer_cred().map_err(|e| ProxyError::Connect(e.to_string()))?.uid();
    if !peer_ok(peer, uid) {
        return Err(ProxyError::Peer { got: peer, want: uid });
    }
    Ok(stream)
}

fn wants_upgrade(request: &Request<Body>) -> bool {
    request
        .headers()
        .get(axum::http::header::CONNECTION)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|t| t.trim().eq_ignore_ascii_case("upgrade")))
}

/// Send `request` over `stream`. A `101` answer to an upgrade request comes
/// back with the splice task, which the caller registers so a revocation can
/// abort it.
pub async fn forward(stream: UnixStream, mut request: Request<Body>) -> Result<(Response<Body>, Option<JoinHandle<()>>), ProxyError> {
    let client_upgrade = wants_upgrade(&request).then(|| hyper::upgrade::on(&mut request));
    let (mut sender, connection) = hyper::client::conn::http1::handshake::<_, Body>(TokioIo::new(stream)).await.map_err(|e| ProxyError::Http(e.to_string()))?;
    tokio::spawn(async move {
        let _ = connection.with_upgrades().await;
    });
    let mut response = sender.send_request(request).await.map_err(|e| ProxyError::Http(e.to_string()))?;
    if response.status() == StatusCode::SWITCHING_PROTOCOLS {
        if let Some(client_upgrade) = client_upgrade {
            let upstream_upgrade = hyper::upgrade::on(&mut response);
            let splice = tokio::spawn(async move {
                let (Ok(client), Ok(upstream)) = tokio::join!(client_upgrade, upstream_upgrade) else {
                    return;
                };
                let mut client = TokioIo::new(client);
                let mut upstream = TokioIo::new(upstream);
                let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
            });
            return Ok((response.map(|_| Body::empty()), Some(splice)));
        }
    }
    Ok((response.map(Body::new), None))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_account_or_root_may_answer() {
        assert!(peer_ok(1001, 1001));
        assert!(peer_ok(0, 1001), "a socket-activated socket is root's");
        assert!(!peer_ok(1002, 1001));
    }
}

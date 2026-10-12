//! Cancellable Ollama transport. No app state or Tauri handles; dropping the
//! generation future drops its HTTP response/socket, including while waiting
//! for the first token. Reservations make cancel-before-start race-free.
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex, OnceLock,
};
use std::time::{Duration, Instant};
use tokio::sync::watch;

struct Request {
    created: Instant,
    cancel: watch::Sender<bool>,
    started: bool,
}
static REQUESTS: OnceLock<Mutex<HashMap<String, Request>>> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn requests() -> &'static Mutex<HashMap<String, Request>> {
    REQUESTS.get_or_init(Default::default)
}

pub fn reserve() -> Result<String, String> {
    let mut map = requests().lock().map_err(|_| "completion lock")?;
    // Reclaim abandoned reservations (e.g. a webview closed during IPC).
    map.retain(|_, r| r.started || r.created.elapsed() < Duration::from_secs(60));
    if map.len() >= 128 {
        return Err("too many completions".into());
    }
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed).to_string();
    let (cancel, _) = watch::channel(false);
    map.insert(
        id.clone(),
        Request {
            created: Instant::now(),
            cancel,
            started: false,
        },
    );
    Ok(id)
}

pub fn cancel(id: &str) {
    if let Ok(mut map) = requests().lock() {
        if let Some(request) = map.remove(id) {
            let _ = request.cancel.send(true);
        }
    }
}

struct Cleanup(String);
impl Drop for Cleanup {
    fn drop(&mut self) {
        cancel(&self.0);
    }
}

pub async fn run<T>(
    id: String,
    work: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    let mut canceled = {
        let mut map = requests().lock().map_err(|_| "completion lock")?;
        let request = map.get_mut(&id).ok_or("completion canceled")?;
        if request.started {
            return Err("completion already started".into());
        }
        request.started = true;
        request.cancel.subscribe()
    };
    let _cleanup = Cleanup(id);
    tokio::select! {
        biased;
        _ = canceled.changed() => Err("completion canceled".into()),
        result = tokio::time::timeout(Duration::from_secs(120), work) =>
            result.map_err(|_| "completion timed out".to_string())?,
    }
}

pub fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        // Prompts must go only to the configured, validated Ollama endpoint.
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(4))
        .pool_max_idle_per_host(0)
        .build()
        .map_err(|e| e.to_string())
}

/// Read NDJSON across arbitrary HTTP chunk / UTF-8 boundaries. Ignore thinking
/// fields and metadata; require an explicit done record or caller-requested
/// semantic stop (update returns true), never accept a disconnected response.
pub async fn stream(
    client: &reqwest::Client,
    url: &str,
    body: &serde_json::Value,
    mut update: impl FnMut(&str, bool) -> Result<bool, String>,
) -> Result<String, String> {
    let mut response = client
        .post(url)
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("ollama HTTP {}", response.status().as_u16()));
    }
    let mut pending = Vec::new();
    let mut raw = String::new();
    loop {
        let chunk = response.chunk().await.map_err(|e| e.to_string())?;
        let eof = chunk.is_none();
        if let Some(chunk) = chunk {
            pending.extend_from_slice(&chunk);
        }
        if pending.len() > 1_048_576 {
            return Err("ollama record too large".into());
        }
        while let Some(end) = pending
            .iter()
            .position(|&b| b == b'\n')
            .map(|i| i + 1)
            .or_else(|| (eof && !pending.is_empty()).then_some(pending.len()))
        {
            let line: Vec<_> = pending.drain(..end).collect();
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            let v: serde_json::Value =
                serde_json::from_slice(&line).map_err(|e| format!("ollama json: {e}"))?;
            if let Some(error) = v["error"].as_str() {
                return Err(error.into());
            }
            let token = v["response"]
                .as_str()
                .or_else(|| v["message"]["content"].as_str())
                .unwrap_or("");
            raw.push_str(token);
            if raw.len() > 262_144 {
                return Err("ollama completion too large".into());
            }
            let done = v["done"].as_bool() == Some(true);
            if !token.is_empty() || done {
                // A caller's semantic stop drops the response/socket immediately.
                if update(&raw, done)? {
                    return Ok(raw);
                }
            }
            if done {
                return Ok(raw);
            }
        }
        if eof {
            return Err("ollama incomplete stream".into());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// `reqwest` is built with `rustls-no-provider`: the HOST installs the
    /// process-wide crypto provider at startup (`mail_engine::
    /// install_crypto_provider`), and a client built before that panics.
    /// These tests are the host here, so install one (idempotent) first.
    fn client() -> Result<reqwest::Client, String> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        super::client()
    }

    async fn server() -> (String, tokio::net::TcpListener) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        (
            format!("http://{}", listener.local_addr().unwrap()),
            listener,
        )
    }

    async fn read_request(socket: &mut tokio::net::TcpStream) {
        let mut data = Vec::new();
        let mut byte = [0];
        while !data.ends_with(b"\r\n\r\n") {
            socket.read_exact(&mut byte).await.unwrap();
            data.push(byte[0]);
        }
        let headers = String::from_utf8(data).unwrap().to_ascii_lowercase();
        let size: usize = headers
            .lines()
            .find_map(|l| l.strip_prefix("content-length: "))
            .unwrap()
            .parse()
            .unwrap();
        socket.read_exact(&mut vec![0; size]).await.unwrap();
    }

    #[tokio::test]
    async fn cancellation_before_start_never_polls_work() {
        let id = reserve().unwrap();
        cancel(&id);
        let result: Result<(), _> = run(id, async { panic!("canceled work started") }).await;
        assert_eq!(result.unwrap_err(), "completion canceled");
    }

    #[tokio::test]
    async fn cancellation_closes_socket_before_first_token() {
        let (url, listener) = server().await;
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let peer = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            read_request(&mut socket).await;
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
            ready_tx.send(()).unwrap();
            // A canceled future must release the live response connection:
            // EOF, or a reset where the OS (macOS) aborts it instead of FIN.
            let read = tokio::time::timeout(Duration::from_secs(3), socket.read(&mut [0]))
                .await
                .unwrap();
            match read {
                Ok(n) => assert_eq!(n, 0),
                Err(e) => assert_eq!(e.kind(), std::io::ErrorKind::ConnectionReset),
            }
        });
        let id = reserve().unwrap();
        let worker_id = id.clone();
        let work = tokio::spawn(async move {
            run(worker_id, async {
                stream(&client()?, &url, &serde_json::json!({}), |_, _| Ok(false)).await
            })
            .await
        });
        ready_rx.await.unwrap();
        cancel(&id);
        assert_eq!(work.await.unwrap().unwrap_err(), "completion canceled");
        peer.await.unwrap();
    }

    #[tokio::test]
    async fn streams_split_utf8_and_final_record_without_newline() {
        let (url, listener) = server().await;
        let peer = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            read_request(&mut socket).await;
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
            // Deliberately split every byte, including a multibyte character.
            for byte in "{\"message\":{\"content\":\"grü\"},\"done\":false}\n{\"response\":\"n\",\"done\":true}".as_bytes() {
                socket.write_all(&[*byte]).await.unwrap();
                tokio::task::yield_now().await;
            }
        });
        let mut seen = Vec::new();
        let result = stream(
            &client().unwrap(),
            &url,
            &serde_json::json!({}),
            |text, done| {
                seen.push((text.to_string(), done));
                Ok(false)
            },
        )
        .await
        .unwrap();
        assert_eq!(result, "grün");
        assert_eq!(seen, vec![("grü".into(), false), ("grün".into(), true)]);
        peer.await.unwrap();
    }

    #[tokio::test]
    async fn semantic_stop_closes_the_socket_without_waiting_for_done() {
        let (url, listener) = server().await;
        let peer = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            read_request(&mut socket).await;
            socket.write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{\"response\":\"One sentence. Next\",\"done\":false}\n").await.unwrap();
            let n = tokio::time::timeout(Duration::from_secs(3), socket.read(&mut [0]))
                .await.unwrap().unwrap();
            assert_eq!(n, 0);
        });
        let raw = stream(&client().unwrap(), &url, &serde_json::json!({}), |text, done| {
            assert!(!done);
            Ok(text.contains(". "))
        }).await.unwrap();
        assert_eq!(raw, "One sentence. Next");
        peer.await.unwrap();
    }

    #[tokio::test]
    async fn rejects_errors_and_truncated_streams() {
        for body in [
            "{\"error\":\"model unavailable\"}\n",
            "{\"response\":\"partial\"}\n",
            "broken\n",
        ] {
            let (url, listener) = server().await;
            let peer = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                read_request(&mut socket).await;
                socket
                    .write_all(
                        format!("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{body}").as_bytes(),
                    )
                    .await
                    .unwrap();
            });
            assert!(
                stream(&client().unwrap(), &url, &serde_json::json!({}), |_, _| Ok(
                    false
                ))
                .await
                .is_err()
            );
            peer.await.unwrap();
        }
    }
}

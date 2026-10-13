//! Bounded LSP framing and concurrent request correlation. Server logs are
//! discarded; callers explicitly handle status and server-to-client requests.
use serde_json::{json, Value};
use app_core::sync::LockExt;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tokio::io::{
    AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader,
};
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};

const MAX_FRAME: usize = 8 * 1024 * 1024;
const MAX_HEADERS: usize = 8192;
type Reply = Result<Value, RpcError>;
type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Reply>>>>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RpcError {
    Closed,
    InvalidFrame,
    Timeout,
    Cancelled,
    Server(i64),
}

pub async fn read_frame<R: AsyncBufRead + Unpin>(reader: &mut R) -> Reply {
    let mut length = None;
    let mut total = 0;
    loop {
        // read_until itself is unbounded; take limits each header before allocation.
        let mut line = Vec::new();
        let read = reader
            .take((MAX_HEADERS - total + 1) as u64)
            .read_until(b'\n', &mut line)
            .await
            .map_err(|_| RpcError::Closed)?;
        if read == 0 {
            return Err(RpcError::Closed);
        }
        total += read;
        if total > MAX_HEADERS || !line.ends_with(b"\r\n") {
            return Err(RpcError::InvalidFrame);
        }
        if line == b"\r\n" {
            break;
        }
        let header =
            std::str::from_utf8(&line[..line.len() - 2]).map_err(|_| RpcError::InvalidFrame)?;
        let (key, value) = header.split_once(':').ok_or(RpcError::InvalidFrame)?;
        if key.eq_ignore_ascii_case("content-length") {
            if length.is_some() {
                return Err(RpcError::InvalidFrame);
            }
            let parsed = value
                .trim()
                .parse::<usize>()
                .map_err(|_| RpcError::InvalidFrame)?;
            if parsed == 0 || parsed > MAX_FRAME {
                return Err(RpcError::InvalidFrame);
            }
            length = Some(parsed);
        }
    }
    let mut body = vec![0; length.ok_or(RpcError::InvalidFrame)?];
    reader
        .read_exact(&mut body)
        .await
        .map_err(|_| RpcError::Closed)?;
    let message: Value = serde_json::from_slice(&body).map_err(|_| RpcError::InvalidFrame)?;
    if message.get("jsonrpc").and_then(Value::as_str) != Some("2.0") || !message.is_object() {
        return Err(RpcError::InvalidFrame);
    }
    Ok(message)
}

pub async fn write_frame<W: AsyncWrite + Unpin>(
    writer: &mut W,
    message: &Value,
) -> Result<(), RpcError> {
    let body = serde_json::to_vec(message).map_err(|_| RpcError::InvalidFrame)?;
    if body.len() > MAX_FRAME {
        return Err(RpcError::InvalidFrame);
    }
    writer
        .write_all(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes())
        .await
        .map_err(|_| RpcError::Closed)?;
    writer
        .write_all(&body)
        .await
        .map_err(|_| RpcError::Closed)?;
    writer.flush().await.map_err(|_| RpcError::Closed)
}

pub struct RpcClient {
    writer: AsyncMutex<Box<dyn AsyncWrite + Unpin + Send>>,
    pending: Pending,
    next: AtomicU64,
    closed: Arc<AtomicBool>,
    reader: tokio::task::JoinHandle<()>,
}

impl RpcClient {
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.reader.abort();
        for (_, sender) in self.pending.lock_ok().drain() {
            let _ = sender.send(Err(RpcError::Closed));
        }
    }
    /// The owner consumes server calls and must reply to requests with an id.
    /// A full event channel closes the connection, never silently drops billing
    /// messages or blocks replies behind an unattended window.
    pub fn connect<R, W>(reader: R, writer: W) -> (Self, mpsc::Receiver<Value>)
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let requests = pending.clone();
        let closed = Arc::new(AtomicBool::new(false));
        let reader_closed = closed.clone();
        let (events, receive) = mpsc::channel(64);
        let reader = tokio::spawn(async move {
            let mut reader = BufReader::new(reader);
            let failure = loop {
                let message = match read_frame(&mut reader).await {
                    Ok(message) => message,
                    Err(error) => break error,
                };
                if let Some(method) = message.get("method").and_then(Value::as_str) {
                    if method == "window/logMessage" || method == "$/logTrace" {
                        continue;
                    }
                    if events.try_send(message).is_err() {
                        break RpcError::Closed;
                    }
                } else if let Some(id) = message.get("id").and_then(Value::as_u64) {
                    if let Some(sender) = requests.lock_ok().remove(&id) {
                        let reply = if let Some(error) = message.get("error") {
                            Err(RpcError::Server(
                                error.get("code").and_then(Value::as_i64).unwrap_or(-32603),
                            ))
                        } else {
                            message.get("result").cloned().ok_or(RpcError::InvalidFrame)
                        };
                        let _ = sender.send(reply);
                    }
                } else {
                    break RpcError::InvalidFrame;
                }
            };
            reader_closed.store(true, Ordering::Release);
            for (_, sender) in requests.lock_ok().drain() {
                let _ = sender.send(Err(failure.clone()));
            }
        });
        (
            Self {
                writer: AsyncMutex::new(Box::new(writer)),
                pending,
                next: AtomicU64::new(1),
                closed,
                reader,
            },
            receive,
        )
    }

    pub async fn send(&self, message: Value) -> Result<(), RpcError> {
        let mut writer = self.writer.lock().await;
        if self.closed.load(Ordering::Acquire) {
            return Err(RpcError::Closed);
        }
        let mut guard = WriteGuard {
            client: self,
            complete: false,
        };
        let result = write_frame(&mut *writer, &message).await;
        guard.complete = result.is_ok();
        result
    }

    pub async fn notify(&self, method: &str, params: Value) -> Result<(), RpcError> {
        self.send(json!({"jsonrpc":"2.0", "method":method, "params":params}))
            .await
    }

    pub async fn reply(&self, id: Value, result: Value) -> Result<(), RpcError> {
        self.send(json!({"jsonrpc":"2.0", "id":id, "result":result}))
            .await
    }

    /// Allocation is separate from execution so cancellation can target work
    /// immediately, before the server has produced a response.
    pub fn next_id(&self) -> u64 {
        self.next.fetch_add(1, Ordering::Relaxed)
    }

    pub async fn request(&self, id: u64, method: &str, params: Value, timeout: Duration) -> Reply {
        let (send, receive) = oneshot::channel();
        {
            let mut pending = self.pending.lock_ok();
            if pending.contains_key(&id) {
                return Err(RpcError::InvalidFrame);
            }
            pending.insert(id, send);
        }
        // Also clean up if the requesting future is dropped by its owner.
        let _guard = PendingGuard {
            id,
            pending: self.pending.clone(),
        };
        let result = tokio::time::timeout(timeout, async {
            self.send(json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params}))
                .await?;
            receive.await.map_err(|_| RpcError::Closed)?
        })
        .await;
        match result {
            Ok(reply) => reply,
            Err(_) => {
                // A blocked stdin must not turn a request timeout into a hang.
                let _ = tokio::time::timeout(Duration::from_millis(250), self.cancel(id)).await;
                Err(RpcError::Timeout)
            }
        }
    }

    pub async fn cancel(&self, id: u64) -> Result<(), RpcError> {
        if let Some(sender) = self.pending.lock_ok().remove(&id) {
            let _ = sender.send(Err(RpcError::Cancelled));
        }
        self.notify("$/cancelRequest", json!({"id":id})).await
    }
}

struct PendingGuard {
    id: u64,
    pending: Pending,
}
impl Drop for PendingGuard {
    fn drop(&mut self) {
        self.pending.lock_ok().remove(&self.id);
    }
}

/// Dropping a write halfway through a frame makes the byte stream unusable.
/// Fail every request rather than appending a cancellation into a partial body.
struct WriteGuard<'a> {
    client: &'a RpcClient,
    complete: bool,
}
impl Drop for WriteGuard<'_> {
    fn drop(&mut self) {
        if !self.complete {
            self.client.closed.store(true, Ordering::Release);
            self.client.reader.abort();
            for (_, sender) in self.client.pending.lock_ok().drain() {
                let _ = sender.send(Err(RpcError::Closed));
            }
        }
    }
}

impl Drop for RpcClient {
    fn drop(&mut self) {
        self.reader.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{duplex, split};

    #[tokio::test]
    async fn utf8_length_and_back_to_back_frames() {
        let (mut write, read) = duplex(1024);
        let message = json!({"jsonrpc":"2.0", "result":"😀λ\r\n", "id":1});
        write_frame(&mut write, &message).await.unwrap();
        write_frame(&mut write, &message).await.unwrap();
        let mut read = BufReader::new(read);
        assert_eq!(read_frame(&mut read).await.unwrap(), message);
        assert_eq!(read_frame(&mut read).await.unwrap(), message);
    }

    #[tokio::test]
    async fn rejects_unbounded_and_ambiguous_frames() {
        for bytes in [
            b"Content-Length: 999999999\r\n\r\n".to_vec(),
            b"Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}".to_vec(),
            b"Content-Length: -1\r\n\r\n".to_vec(),
            vec![b'a'; MAX_HEADERS + 1],
        ] {
            let mut read = BufReader::new(bytes.as_slice());
            assert_eq!(read_frame(&mut read).await, Err(RpcError::InvalidFrame));
        }
    }

    #[tokio::test]
    async fn cancellation_drops_late_results_and_keeps_next_request() {
        let (client, server) = duplex(4096);
        let (read, write) = split(client);
        let (client, mut events) = RpcClient::connect(read, write);
        let client = Arc::new(client);
        let worker = client.clone();
        let request = tokio::spawn(async move {
            worker
                .request(1, "complete", json!({}), Duration::from_secs(2))
                .await
        });
        let (read, mut write) = split(server);
        let mut read = BufReader::new(read);
        assert_eq!(read_frame(&mut read).await.unwrap()["id"], 1);
        client.cancel(1).await.unwrap();
        assert_eq!(request.await.unwrap(), Err(RpcError::Cancelled));
        assert_eq!(
            read_frame(&mut read).await.unwrap()["method"],
            "$/cancelRequest"
        );
        write_frame(
            &mut write,
            &json!({"jsonrpc":"2.0", "id":1, "result":"stale"}),
        )
        .await
        .unwrap();
        let worker = client.clone();
        let request = tokio::spawn(async move {
            worker
                .request(2, "complete", json!({}), Duration::from_secs(2))
                .await
        });
        assert_eq!(read_frame(&mut read).await.unwrap()["id"], 2);
        write_frame(
            &mut write,
            &json!({"jsonrpc":"2.0", "method":"window/logMessage", "params":{"message":"discard"}}),
        )
        .await
        .unwrap();
        write_frame(
            &mut write,
            &json!({"jsonrpc":"2.0", "method":"didChangeStatus", "params":{"kind":"Normal"}}),
        )
        .await
        .unwrap();
        write_frame(
            &mut write,
            &json!({"jsonrpc":"2.0", "id":2, "result":"current"}),
        )
        .await
        .unwrap();
        assert_eq!(request.await.unwrap().unwrap(), "current");
        assert_eq!(events.recv().await.unwrap()["method"], "didChangeStatus");
        assert!(events.try_recv().is_err());
    }

    #[tokio::test]
    async fn timeout_cancels_and_cleans_pending_requests() {
        let (client, server) = duplex(4096);
        let (read, write) = split(client);
        let (client, _events) = RpcClient::connect(read, write);
        assert_eq!(
            client
                .request(1, "hang", json!({}), Duration::from_millis(10))
                .await,
            Err(RpcError::Timeout)
        );
        assert!(client.pending.lock().unwrap().is_empty());
        let mut server = BufReader::new(server);
        assert_eq!(read_frame(&mut server).await.unwrap()["method"], "hang");
        assert_eq!(
            read_frame(&mut server).await.unwrap()["method"],
            "$/cancelRequest"
        );
    }

    #[tokio::test]
    async fn interrupted_frame_closes_connection_instead_of_corrupting_next_request() {
        let (client, _blocked_server) = duplex(8);
        let (read, write) = split(client);
        let (client, _events) = RpcClient::connect(read, write);
        assert_eq!(
            client
                .request(1, "hang", json!({}), Duration::from_millis(10))
                .await,
            Err(RpcError::Timeout)
        );
        assert_eq!(
            client.notify("next", json!({})).await,
            Err(RpcError::Closed)
        );
        assert!(client.pending.lock().unwrap().is_empty());
    }
}

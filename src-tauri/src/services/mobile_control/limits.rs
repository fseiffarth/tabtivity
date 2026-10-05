//! Accept-side bounds for the mobile host.
//!
//! `axum::serve` applies none of its own: hyper has no default header-read
//! timeout and nothing capped concurrent connections, so an unauthenticated
//! tailnet peer could open thousands of dribbling connections and exhaust the
//! sidecar's file descriptors without ever authenticating.
//!
//! Three bounds, all on the raw stream so they apply *before* any handler runs:
//!
//! * a semaphore permit per accepted connection, released when the stream drops;
//! * a handshake deadline on a connection the server has not yet written a
//!   single byte to. It bounds the first request's *headers*: a connection
//!   that never finishes them dies at [`HANDSHAKE_TIMEOUT`], however it
//!   dribbles. Once those headers are complete the deadline is moved, once, to
//!   [`BODY_TIMEOUT`] from that moment — the time the first request's body and
//!   its handler get before the first response byte. An upload route reads its
//!   whole body (up to 24 MiB) before it writes anything, so on a fresh
//!   connection the handshake window used to cut any upload slower than 15 s.
//!   The body window is fixed, not re-armed by body bytes: the body is read
//!   before the handler authenticates, so an unauthenticated peer can hold a
//!   permit for at most the two windows together;
//! * once the server has answered, an idle deadline re-armed by every byte read
//!   or written. Without it, 256 sockets held open after one completed request
//!   — from any tailnet node, or any local process, since the agent fence
//!   shares the network namespace — sat on every permit for as long as the
//!   kernel kept them, and the phone could not connect at all. A live
//!   WebSocket is never idle this long: the phone pings every 20 s in the
//!   foreground and about once a minute throttled in the background. Second
//!   and later requests on a kept-alive connection — their headers, bodies and
//!   handlers — are under this rule alone, as they always were: such a peer
//!   has already been answered once, and each silence is bounded, not the
//!   request as a whole.
//!
//! `axum::serve` exposes no hyper builder, so hyper's own header-read timeout
//! is out of reach here; the end of the headers is recognized on the raw bytes
//! instead ([`HeaderEnd`]).

use std::{
    future::Future,
    io,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};

use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::{TcpListener, TcpStream},
    sync::{OwnedSemaphorePermit, Semaphore},
    time::{sleep, Sleep},
};

/// Generous next to a phone's handful of sockets, small enough that the process
/// stays far below any sane file-descriptor limit.
pub const MAX_CONNECTIONS: usize = 256;
/// A real client completes its request headers in milliseconds over loopback.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
/// How long the first request on a connection has, from the end of its
/// headers, until the server's first response byte. Matches the phone's own
/// upload deadline (`UPLOAD_TIMEOUT` in `mobile-web/src/api.ts`), and outlasts
/// the slowest desktop answer a handler waits for (`response_timeout`, 65 s).
pub const BODY_TIMEOUT: Duration = Duration::from_secs(120);
/// How long an answered connection may carry no byte in either direction.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);

pub struct GuardedListener {
    inner: TcpListener,
    permits: Arc<Semaphore>,
}

impl GuardedListener {
    pub fn new(inner: TcpListener) -> Self {
        Self {
            inner,
            permits: Arc::new(Semaphore::new(MAX_CONNECTIONS)),
        }
    }
}

impl axum::serve::Listener for GuardedListener {
    type Io = GuardedStream;
    type Addr = std::net::SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            // Wait for a slot *before* accepting, so an overload leaves
            // connections queued in the kernel rather than held open by us.
            let Ok(permit) = self.permits.clone().acquire_owned().await else {
                std::future::pending::<()>().await;
                unreachable!("the semaphore is never closed");
            };
            match self.inner.accept().await {
                Ok((stream, addr)) => return (GuardedStream::new(stream, permit), addr),
                // Matches axum's own behaviour: a per-connection accept error
                // must never take the listener down.
                Err(_) => continue,
            }
        }
    }

    fn local_addr(&self) -> io::Result<Self::Addr> {
        self.inner.local_addr()
    }
}

/// Finds the blank line that ends a request's headers (`\r\n\r\n`) in a
/// byte stream, wherever the reads happen to split it.
///
/// Bare-LF line endings are not recognized. A client that sends them stays
/// under the handshake deadline for its whole request — the tighter bound, so
/// missing the terminator can only ever cost the client, never the limit.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct HeaderEnd {
    /// How many bytes of the terminator the stream currently ends with.
    matched: u8,
}

impl HeaderEnd {
    const TERMINATOR: &'static [u8; 4] = b"\r\n\r\n";

    /// Feed the next bytes read; whether the terminator is now complete.
    fn feed(&mut self, bytes: &[u8]) -> bool {
        for &byte in bytes {
            if byte == Self::TERMINATOR[usize::from(self.matched)] {
                self.matched += 1;
                if usize::from(self.matched) == Self::TERMINATOR.len() {
                    return true;
                }
            } else {
                // Only a `\r` can begin the terminator anew.
                self.matched = u8::from(byte == b'\r');
            }
        }
        false
    }
}

/// Which deadline a connection is under.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// Nothing written yet and the first request's headers still arriving:
    /// the handshake deadline, fixed at accept. Reads never re-arm it — a
    /// slowloris dribbling one header byte per second must not be able to keep
    /// the window open.
    Headers(HeaderEnd),
    /// Headers complete, nothing written yet: the body window, set once.
    Body,
    /// The server has written: the idle deadline, re-armed by every byte.
    Answered,
}

pub struct GuardedStream {
    inner: TcpStream,
    _permit: OwnedSemaphorePermit,
    /// The deadline of the current [`Phase`].
    deadline: Pin<Box<Sleep>>,
    phase: Phase,
}

impl GuardedStream {
    fn new(inner: TcpStream, permit: OwnedSemaphorePermit) -> Self {
        Self {
            inner,
            _permit: permit,
            deadline: Box::pin(sleep(HANDSHAKE_TIMEOUT)),
            phase: Phase::Headers(HeaderEnd::default()),
        }
    }

    fn rearm_idle(&mut self) {
        self.deadline
            .as_mut()
            .reset(tokio::time::Instant::now() + IDLE_TIMEOUT);
    }

    /// The server wrote: this is a real exchange, so whichever pre-answer
    /// deadline was running gives way to the idle one, which every byte re-arms.
    fn answered(&mut self) {
        self.phase = Phase::Answered;
        self.rearm_idle();
    }

    /// Account for bytes just read from the peer.
    fn note_read(&mut self, bytes: &[u8]) {
        match &mut self.phase {
            Phase::Headers(end) => {
                if end.feed(bytes) {
                    // Once, from here: whatever of the body arrived in the
                    // same read, and every byte after, moves nothing.
                    self.phase = Phase::Body;
                    self.deadline
                        .as_mut()
                        .reset(tokio::time::Instant::now() + BODY_TIMEOUT);
                }
            }
            Phase::Body => {}
            Phase::Answered => self.rearm_idle(),
        }
    }
}

impl AsyncRead for GuardedStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        // Polling the timer here is what makes it fire on a silent connection:
        // it registers our waker, so a peer that sends nothing still wakes us at
        // the deadline instead of parking forever on `Poll::Pending`.
        if self.deadline.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::TimedOut,
                match self.phase {
                    Phase::Headers(_) => "handshake timeout",
                    Phase::Body => "body timeout",
                    Phase::Answered => "idle timeout",
                },
            )));
        }
        let before = buf.filled().len();
        let read = Pin::new(&mut self.inner).poll_read(cx, buf);
        if matches!(read, Poll::Ready(Ok(()))) && buf.filled().len() > before {
            self.note_read(&buf.filled()[before..]);
        }
        read
    }
}

impl AsyncWrite for GuardedStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let written = Pin::new(&mut self.inner).poll_write(cx, buf);
        if matches!(written, Poll::Ready(Ok(_))) {
            self.answered();
        }
        written
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        let written = Pin::new(&mut self.inner).poll_write_vectored(cx, bufs);
        if matches!(written, Poll::Ready(Ok(_))) {
            self.answered();
        }
        written
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn listener() -> (GuardedListener, SocketAddr) {
        let inner = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
            .await
            .expect("bind");
        let address = inner.local_addr().expect("addr");
        (GuardedListener::new(inner), address)
    }

    #[tokio::test(start_paused = true)]
    async fn a_silent_connection_is_dropped_at_the_handshake_deadline() {
        use axum::serve::Listener;
        let (mut guarded, address) = listener().await;
        let client = tokio::spawn(async move {
            let mut stream = TcpStream::connect(address).await.expect("connect");
            // Never send anything, as a slowloris would.
            let mut buffer = [0u8; 1];
            let _ = stream.read(&mut buffer).await;
        });
        let (stream, _) = guarded.accept().await;
        let mut stream = stream;
        let mut buffer = [0u8; 64];
        let error = stream.read(&mut buffer).await.expect_err("timed out");
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        drop(stream);
        client.abort();
    }

    // Every socket wait runs on the real clock: a paused clock auto-advances
    // whenever the runtime waits on socket I/O, so a deadline could fire
    // before loopback bytes arrive (the handshake one did before `hello`, the
    // idle one before `more`, both on macOS CI). Only the long idle itself is
    // skipped, by an explicit advance while no read is waiting.
    #[tokio::test]
    async fn answering_the_client_lifts_the_deadline() {
        use axum::serve::Listener;
        let (mut guarded, address) = listener().await;
        let client = tokio::spawn(async move {
            let mut stream = TcpStream::connect(address).await.expect("connect");
            stream.write_all(b"hello").await.expect("write");
            let mut buffer = [0u8; 2];
            let _ = stream.read_exact(&mut buffer).await;
            stream.write_all(b"more").await
        });
        let (mut stream, _) = guarded.accept().await;
        let mut buffer = [0u8; 5];
        stream.read_exact(&mut buffer).await.expect("read request");
        stream.write_all(b"ok").await.expect("respond");
        // Idle well past the handshake window before the next read.
        tokio::time::pause();
        tokio::time::advance(HANDSHAKE_TIMEOUT * 4).await;
        tokio::time::resume();
        let mut rest = [0u8; 4];
        stream.read_exact(&mut rest).await.expect("still open");
        assert_eq!(&rest, b"more");
        client.await.expect("client task").expect("client write");
    }

    // Real clock for the exchange, paused for the idle; no bytes are awaited
    // while paused, so auto-advance can only reach the deadline. A client that answered once and then held the socket open
    // without a byte used to keep its permit until the kernel gave up on it.
    #[tokio::test]
    async fn an_answered_connection_that_falls_silent_is_closed_after_the_idle_window() {
        use axum::serve::Listener;
        let (mut guarded, address) = listener().await;
        let client = tokio::spawn(async move {
            let mut stream = TcpStream::connect(address).await.expect("connect");
            stream.write_all(b"hello").await.expect("write");
            let mut buffer = [0u8; 2];
            let _ = stream.read_exact(&mut buffer).await;
            // Then hold the socket open and say nothing, ever.
            let mut rest = [0u8; 1];
            let _ = stream.read(&mut rest).await;
        });
        let (mut stream, _) = guarded.accept().await;
        let mut buffer = [0u8; 5];
        stream.read_exact(&mut buffer).await.expect("read request");
        stream.write_all(b"ok").await.expect("respond");
        tokio::time::pause();
        let started = tokio::time::Instant::now();
        let mut rest = [0u8; 4];
        let error = stream.read(&mut rest).await.expect_err("idle timeout");
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() >= IDLE_TIMEOUT);
        // Well past the handshake window, which no longer applies here.
        assert!(started.elapsed() > HANDSHAKE_TIMEOUT * 4);
        drop(stream);
        client.abort();
    }

    const HEADERS: &[u8] = b"POST /api/v1/inbox HTTP/1.1\r\nHost: h\r\nContent-Length: 9\r\n\r\n";

    /// Skip `duration` with no read waiting, as the tests above do.
    async fn skip(duration: Duration) {
        tokio::time::pause();
        tokio::time::advance(duration).await;
        tokio::time::resume();
    }

    #[test]
    fn the_end_of_headers_is_found_wherever_the_reads_split_it() {
        let mut whole = HeaderEnd::default();
        assert!(whole.feed(HEADERS));
        for split in 1..HEADERS.len() {
            let mut end = HeaderEnd::default();
            let (first, second) = HEADERS.split_at(split);
            assert!(!end.feed(first), "split at {split}");
            assert!(end.feed(second), "split at {split}");
        }
        // One byte at a time, and a `\r` that restarts a broken terminator.
        let mut end = HeaderEnd::default();
        let dribbled = b"A: b\r\n\r\r\n\r\n";
        let found: Vec<bool> = dribbled.iter().map(|byte| end.feed(&[*byte])).collect();
        assert_eq!(found.iter().filter(|hit| **hit).count(), 1);
        assert!(found[dribbled.len() - 1]);
        // Line ends alone, or bare LFs, are not the end of the headers.
        let mut end = HeaderEnd::default();
        assert!(!end.feed(b"GET / HTTP/1.1\r\nHost: h\r\nA: b\n\nmore\r\n"));
    }

    // An upload: complete headers, then a body that is still arriving long
    // after the handshake window, with the server yet to write a byte. Real
    // clock for every socket wait, as above.
    #[tokio::test]
    async fn a_body_outlives_the_handshake_deadline_once_the_headers_are_complete() {
        use axum::serve::Listener;
        let (mut guarded, address) = listener().await;
        let go = Arc::new(tokio::sync::Notify::new());
        let client_go = go.clone();
        let client = tokio::spawn(async move {
            let mut stream = TcpStream::connect(address).await.expect("connect");
            stream.write_all(HEADERS).await.expect("headers");
            client_go.notified().await;
            stream.write_all(b"body-tail").await
        });
        let (mut stream, _) = guarded.accept().await;
        let mut headers = vec![0u8; HEADERS.len()];
        stream.read_exact(&mut headers).await.expect("read headers");
        skip(HANDSHAKE_TIMEOUT * 4).await;
        go.notify_one();
        let mut body = [0u8; 9];
        stream.read_exact(&mut body).await.expect("still open for the body");
        assert_eq!(&body, b"body-tail");
        client.await.expect("client task").expect("client write");
    }

    // The same, with the terminator arriving in two reads.
    #[tokio::test]
    async fn a_header_terminator_split_across_two_reads_still_opens_the_body_window() {
        use axum::serve::Listener;
        let (mut guarded, address) = listener().await;
        let go = Arc::new(tokio::sync::Notify::new());
        let client_go = go.clone();
        let (first, second) = HEADERS.split_at(HEADERS.len() - 2);
        let client = tokio::spawn(async move {
            let mut stream = TcpStream::connect(address).await.expect("connect");
            stream.write_all(first).await.expect("first part");
            client_go.notified().await;
            stream.write_all(second).await.expect("second part");
            client_go.notified().await;
            stream.write_all(b"body-tail").await
        });
        let (mut stream, _) = guarded.accept().await;
        let mut part = vec![0u8; first.len()];
        stream.read_exact(&mut part).await.expect("read first part");
        assert!(matches!(stream.phase, Phase::Headers(_)));
        go.notify_one();
        let mut part = vec![0u8; second.len()];
        stream.read_exact(&mut part).await.expect("read second part");
        assert_eq!(stream.phase, Phase::Body);
        skip(HANDSHAKE_TIMEOUT * 4).await;
        go.notify_one();
        let mut body = [0u8; 9];
        stream.read_exact(&mut body).await.expect("still open for the body");
        client.await.expect("client task").expect("client write");
    }

    // Header bytes that keep coming but never end are a slowloris: the
    // handshake deadline, fixed at accept, still cuts them. Paused only once
    // nothing more is awaited from the socket.
    #[tokio::test]
    async fn headers_that_never_complete_still_die_at_the_handshake_deadline() {
        use axum::serve::Listener;
        let (mut guarded, address) = listener().await;
        let partial = &HEADERS[..HEADERS.len() - 1];
        let client = tokio::spawn(async move {
            let mut stream = TcpStream::connect(address).await.expect("connect");
            stream.write_all(partial).await.expect("write");
            let mut rest = [0u8; 1];
            let _ = stream.read(&mut rest).await;
        });
        let (mut stream, _) = guarded.accept().await;
        let mut read = vec![0u8; partial.len()];
        stream.read_exact(&mut read).await.expect("read partial headers");
        tokio::time::pause();
        let started = tokio::time::Instant::now();
        let mut rest = [0u8; 4];
        let error = stream.read(&mut rest).await.expect_err("handshake timeout");
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert_eq!(error.to_string(), "handshake timeout");
        // The timer wheel rounds a deadline up by a millisecond or so.
        assert!(started.elapsed() < HANDSHAKE_TIMEOUT + Duration::from_secs(1));
        drop(stream);
        client.abort();
    }

    // The body window is one fixed span from the end of the headers: a body
    // byte arriving late in it buys no more time, so an unauthenticated peer
    // cannot hold a permit by dribbling.
    #[tokio::test]
    async fn a_body_that_stalls_is_cut_at_the_body_window_whatever_it_dribbled() {
        use axum::serve::Listener;
        let (mut guarded, address) = listener().await;
        let go = Arc::new(tokio::sync::Notify::new());
        let client_go = go.clone();
        let client = tokio::spawn(async move {
            let mut stream = TcpStream::connect(address).await.expect("connect");
            stream.write_all(HEADERS).await.expect("headers");
            client_go.notified().await;
            stream.write_all(b"b").await.expect("one body byte");
            // Then hold the socket open and say nothing, ever.
            let mut rest = [0u8; 1];
            let _ = stream.read(&mut rest).await;
        });
        let (mut stream, _) = guarded.accept().await;
        let mut headers = vec![0u8; HEADERS.len()];
        stream.read_exact(&mut headers).await.expect("read headers");
        let late = BODY_TIMEOUT - Duration::from_secs(20);
        assert!(late > HANDSHAKE_TIMEOUT);
        skip(late).await;
        go.notify_one();
        let mut byte = [0u8; 1];
        stream.read_exact(&mut byte).await.expect("a late body byte is read");
        tokio::time::pause();
        let started = tokio::time::Instant::now();
        let error = stream.read(&mut byte).await.expect_err("body timeout");
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert_eq!(error.to_string(), "body timeout");
        // What was left of the one window (give or take the timer wheel's
        // rounding), not a fresh one from that byte.
        assert!(started.elapsed() < BODY_TIMEOUT - late + Duration::from_secs(1));
        drop(stream);
        client.abort();
    }

    #[tokio::test]
    async fn connections_beyond_the_cap_wait_for_a_slot() {
        use axum::serve::Listener;
        let (mut guarded, address) = listener().await;
        assert_eq!(guarded.permits.available_permits(), MAX_CONNECTIONS);
        let _client = TcpStream::connect(address).await.expect("connect");
        let (held, _) = guarded.accept().await;
        assert_eq!(guarded.permits.available_permits(), MAX_CONNECTIONS - 1);
        drop(held);
        assert_eq!(guarded.permits.available_permits(), MAX_CONNECTIONS);
    }
}

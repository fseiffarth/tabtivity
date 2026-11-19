//! Test doubles for the session host: a scripted PTY, a fake clock and a host
//! wired to them over `tokio::io::duplex`. Test-only.

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use super::protocol::{Request, SizePolicy};
use super::server::{Host, HostConfig, Pty, PtySpawner, SpawnSpec, Spawned};
use super::table::Clock;

pub const TOKEN: &str = "secret";

#[derive(Default)]
pub struct FakeClock(AtomicU64);

impl FakeClock {
    pub fn advance(&self, ms: u64) {
        self.0.fetch_add(ms, Ordering::SeqCst);
    }
}

impl Clock for FakeClock {
    fn now_ms(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}

/// A switch tests flip to make a call wait.
#[derive(Default)]
struct Gate {
    held: Mutex<bool>,
    cv: Condvar,
}

impl Gate {
    fn set(&self, held: bool) {
        *self.held.lock().unwrap() = held;
        self.cv.notify_all();
    }

    /// Waits while held and `!stop()`.
    fn wait(&self, stop: impl Fn() -> bool) {
        let mut held = self.held.lock().unwrap();
        while *held && !stop() {
            held = self.cv.wait_timeout(held, Duration::from_millis(5)).unwrap().0;
        }
    }
}

/// The test's handle on one fake child.
#[derive(Clone)]
pub struct FakeChild {
    pub spec: SpawnSpec,
    out: Arc<Mutex<Option<Sender<Vec<u8>>>>>,
    input: Arc<Mutex<Vec<u8>>>,
    sizes: Arc<Mutex<Vec<(u16, u16)>>>,
    exit: Arc<Mutex<Option<i32>>>,
    writes: Arc<Gate>,
    reaped: Arc<AtomicBool>,
}

impl FakeChild {
    /// The child writes `bytes` to its terminal.
    pub fn emit(&self, bytes: &[u8]) {
        if let Some(tx) = self.out.lock().unwrap().as_ref() {
            let _ = tx.send(bytes.to_vec());
        }
    }

    /// The child exits with `code`, closing its output.
    pub fn exit(&self, code: i32) {
        *self.exit.lock().unwrap() = Some(code);
        self.out.lock().unwrap().take();
    }

    /// The child exits but its output stays open, as a ConPTY's does.
    pub fn exit_keeping_output(&self, code: i32) {
        *self.exit.lock().unwrap() = Some(code);
    }

    /// The child stops reading its input: writes block until it exits.
    pub fn stop_reading(&self) {
        self.writes.set(true);
    }

    pub fn input(&self) -> Vec<u8> {
        self.input.lock().unwrap().clone()
    }

    pub fn sizes(&self) -> Vec<(u16, u16)> {
        self.sizes.lock().unwrap().clone()
    }

    pub fn exited(&self) -> Option<i32> {
        *self.exit.lock().unwrap()
    }

    /// `try_wait` reported the exit (the child was reaped).
    pub fn reaped(&self) -> bool {
        self.reaped.load(Ordering::SeqCst)
    }
}

struct FakePty(FakeChild);

impl Pty for FakePty {
    fn resize(&self, cols: u16, rows: u16) -> std::io::Result<()> {
        self.0.sizes.lock().unwrap().push((cols, rows));
        Ok(())
    }
    fn kill(&self) -> std::io::Result<()> {
        self.0.exit(-1);
        Ok(())
    }
    fn try_wait(&self) -> std::io::Result<Option<i32>> {
        let code = self.0.exited();
        if code.is_some() {
            self.0.reaped.store(true, Ordering::SeqCst);
        }
        Ok(code)
    }
    fn pid(&self) -> Option<u32> {
        Some(4242)
    }
}

struct FakeInput(FakeChild);

impl Write for FakeInput {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let child = &self.0;
        child.writes.wait(|| child.exited().is_some());
        if child.exited().is_some() {
            return Err(std::io::ErrorKind::BrokenPipe.into());
        }
        child.input.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

struct FakeReader {
    rx: Receiver<Vec<u8>>,
    pending: Vec<u8>,
}

impl Read for FakeReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.pending.is_empty() {
            match self.rx.recv() {
                Ok(bytes) => self.pending = bytes,
                Err(_) => return Ok(0),
            }
        }
        let n = buf.len().min(self.pending.len());
        buf[..n].copy_from_slice(&self.pending[..n]);
        self.pending.drain(..n);
        Ok(n)
    }
}

/// Spawns [`FakeChild`]ren and remembers them in order.
#[derive(Clone, Default)]
pub struct FakeSpawner {
    children: Arc<Mutex<Vec<FakeChild>>>,
    spawns: Arc<Gate>,
}

impl FakeSpawner {
    pub fn last(&self) -> FakeChild {
        self.children.lock().unwrap().last().cloned().expect("nothing spawned")
    }

    pub fn count(&self) -> usize {
        self.children.lock().unwrap().len()
    }

    /// Spawns block (a slow `CreateProcess`) until [`Self::release_spawns`].
    pub fn hold_spawns(&self) {
        self.spawns.set(true);
    }

    pub fn release_spawns(&self) {
        self.spawns.set(false);
    }
}

impl PtySpawner for FakeSpawner {
    fn spawn(&self, spec: &SpawnSpec) -> std::io::Result<Spawned> {
        self.spawns.wait(|| false);
        let (tx, rx) = channel();
        let child = FakeChild {
            spec: spec.clone(),
            out: Arc::new(Mutex::new(Some(tx))),
            input: Arc::default(),
            sizes: Arc::default(),
            exit: Arc::default(),
            writes: Arc::default(),
            reaped: Arc::default(),
        };
        self.children.lock().unwrap().push(child.clone());
        Ok(Spawned {
            pty: Arc::new(FakePty(child.clone())),
            input: Box::new(FakeInput(child)),
            output: Box::new(FakeReader { rx, pending: Vec::new() }),
        })
    }
}

pub fn test_config() -> HostConfig {
    let mut cfg = HostConfig::new(TOKEN, "test-host", 7);
    cfg.hello_timeout = Duration::from_secs(2);
    cfg
}

pub fn host_with(cfg: HostConfig) -> (Host, FakeSpawner, Arc<FakeClock>) {
    let fake = FakeSpawner::default();
    let clock = Arc::new(FakeClock::default());
    let host = Host::new(cfg, fake.clone(), clock.clone());
    (host, fake, clock)
}

pub fn test_host() -> (Host, FakeSpawner, Arc<FakeClock>) {
    host_with(test_config())
}

/// A client end whose server end `host` serves.
pub fn connect_pair(host: &Host) -> tokio::io::DuplexStream {
    connect_pair_sized(host, 1 << 16)
}

pub fn connect_pair_sized(host: &Host, buf: usize) -> tokio::io::DuplexStream {
    let (client, server) = tokio::io::duplex(buf);
    let host = host.clone();
    tokio::spawn(async move { host.serve(server).await });
    client
}

/// An absolute `argv` on every OS.
pub fn abs_argv() -> Vec<String> {
    vec![std::env::temp_dir().join("fake-agent").to_string_lossy().into_owned(), "--flag".into()]
}

pub fn spawn_req(name: &str, remain_on_exit: bool) -> Request {
    Request::Spawn {
        name: name.into(),
        argv: abs_argv(),
        env: vec![("PATH".into(), "only-this".into())],
        cwd: None,
        cols: 80,
        rows: 24,
        remain_on_exit,
        size_policy: SizePolicy::Latest,
        create_only: false,
        mcp_mark: None,
    }
}

/// Polls `f` until it holds (5 s at most).
pub async fn eventually(mut f: impl FnMut() -> bool) {
    for _ in 0..1000 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("condition never held");
}

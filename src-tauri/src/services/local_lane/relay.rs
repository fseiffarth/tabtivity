//! The in-fence half of the local lane: `<binary> --local-relay PORT=SOCKET… -- CMD ARGS…`.
//!
//! A CLI in a fence with no network speaks TCP to `127.0.0.1:<port>`. This mode
//! is the fence's command: it listens on those ports, forks a server process
//! that pumps every connection to the matching Unix socket (bound into the fence
//! by the app), and then **execs the CLI in its own process**. So the CLI keeps
//! the tab's process identity, terminal and signals; the server process lives
//! in the fence's process group of its own, with no terminal, and dies with the
//! CLI (`PR_SET_PDEATHSIG`, and the fence's pid namespace ends with it).
//!
//! The relay trusts nothing and decides nothing: the app side judges every
//! request. A client that closes its end closes the exchange, so the app drops
//! its upstream connection and the model stops generating.

use std::ffi::OsString;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener, TcpStream};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;

/// The mode flag `main` dispatches on.
pub const MODE_FLAG: &str = "--local-relay";

/// One port the relay listens on and the socket it pumps to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Spec {
    pub port: u16,
    pub socket: PathBuf,
}

/// The arguments that follow the binary, up to and including the `--` that
/// starts the CLI's own command line.
pub fn mode_args(specs: &[Spec]) -> Vec<String> {
    let mut out = vec![MODE_FLAG.to_string()];
    out.extend(specs.iter().map(|s| format!("{}={}", s.port, s.socket.display())));
    out.push("--".to_string());
    out
}

/// Parse what follows [`MODE_FLAG`]: the specs and the command.
pub fn parse(args: &[OsString]) -> Result<(Vec<Spec>, Vec<OsString>), String> {
    let split = args.iter().position(|a| a == "--").ok_or("no `--` before the command")?;
    let specs = args[..split]
        .iter()
        .map(|a| {
            let a = a.to_str().ok_or("a listen spec is not text")?;
            let (port, socket) = a.split_once('=').ok_or("a listen spec is PORT=SOCKET")?;
            let port: u16 = port.parse().ok().filter(|p| *p != 0).ok_or("a listen spec has no valid port")?;
            let socket = PathBuf::from(socket);
            if !socket.is_absolute() {
                return Err("a listen spec names a relative socket".to_string());
            }
            Ok(Spec { port, socket })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let command = args[split + 1..].to_vec();
    if specs.is_empty() || command.is_empty() {
        return Err("a relay needs a port and a command".into());
    }
    Ok((specs, command))
}

/// A running pump: listeners and the threads that accept on them.
pub struct Relay {
    listeners: Vec<(TcpListener, PathBuf)>,
}

impl Relay {
    /// Bind each `(address, socket)`.
    pub fn bind(pairs: &[(SocketAddr, PathBuf)]) -> std::io::Result<Relay> {
        let mut listeners = Vec::new();
        for (addr, socket) in pairs {
            listeners.push((TcpListener::bind(addr)?, socket.clone()));
        }
        Ok(Relay { listeners })
    }

    /// The bound addresses, in order (a test binds port 0).
    pub fn addrs(&self) -> Vec<SocketAddr> {
        self.listeners.iter().filter_map(|(l, _)| l.local_addr().ok()).collect()
    }

    /// Accept on every listener, each on its own thread, and return. The threads
    /// end with the process; a test closes by dropping the sockets' peers.
    pub fn serve(self) {
        for (listener, socket) in self.listeners {
            let _ = std::thread::Builder::new().name("lane-relay".into()).spawn(move || {
                for client in listener.incoming().flatten() {
                    let socket = socket.clone();
                    let _ = std::thread::Builder::new().name("lane-relay-conn".into()).spawn(move || pump(client, &socket));
                }
            });
        }
    }
}

/// The addresses the relay listens on for `port`: `127.0.0.1` always, `::1`
/// where the fence has it (`localhost` may resolve to either).
pub fn listen_addrs(port: u16) -> [SocketAddr; 2] {
    [SocketAddr::from((Ipv4Addr::LOCALHOST, port)), SocketAddr::from((Ipv6Addr::LOCALHOST, port))]
}

fn pump(client: TcpStream, socket: &std::path::Path) {
    let Ok(up) = super::with_socket_path(socket, |p| UnixStream::connect(p)) else { return };
    let _ = client.set_nodelay(true);
    let (Ok(mut client_r), Ok(mut up_w)) = (client.try_clone(), up.try_clone()) else { return };
    let (client_close, up_close) = (client.try_clone(), up.try_clone());
    // Client to app: an end of the client's stream is a hang-up, which closes the
    // whole exchange (the app then drops its upstream connection).
    let _ = std::thread::Builder::new().name("lane-relay-up".into()).spawn(move || {
        copy(&mut client_r, &mut up_w);
        if let Ok(up) = up_close {
            let _ = up.shutdown(std::net::Shutdown::Both);
        }
    });
    // App to client: its end is the end of the response.
    let (mut up_r, mut client_w) = (up, client);
    copy(&mut up_r, &mut client_w);
    let _ = client_w.shutdown(std::net::Shutdown::Both);
    if let Ok(client) = client_close {
        let _ = client.shutdown(std::net::Shutdown::Both);
    }
}

fn copy(from: &mut impl Read, to: &mut impl Write) {
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        match from.read(&mut buf) {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                if to.write_all(&buf[..n]).is_err() || to.flush().is_err() {
                    return;
                }
            }
        }
    }
}

/// `<binary> --local-relay …`: listen, fork the server, exec the CLI. Returns
/// only on failure, with the exit code.
pub fn run(args: &[OsString]) -> i32 {
    use std::os::unix::process::CommandExt;
    let fail = |why: &str, code: i32| {
        eprintln!("{}: local model relay: {why}", crate::brand::SLUG);
        code
    };
    let (specs, command) = match parse(args) {
        Ok(parsed) => parsed,
        Err(why) => return fail(&why, 2),
    };
    let mut listeners = Vec::new();
    for spec in &specs {
        let [v4, v6] = listen_addrs(spec.port);
        match TcpListener::bind(v4) {
            Ok(l) => listeners.push((l, spec.socket.clone())),
            Err(e) => return fail(&format!("could not listen on {v4} ({e})"), 111),
        }
        // Best effort: a fence without IPv6 loopback has no `::1`.
        if let Ok(l) = TcpListener::bind(v6) {
            listeners.push((l, spec.socket.clone()));
        }
    }
    let relay = Relay { listeners };
    let parent = unsafe { libc::getpid() };
    // SAFETY: this process has one thread (nothing has been spawned yet), so the
    // child may use the allocator and threads after the fork.
    match unsafe { libc::fork() } {
        -1 => fail("could not fork the server", 111),
        0 => {
            // The server: its own process group (no terminal signals), no terminal,
            // and gone with the CLI.
            unsafe {
                libc::setpgid(0, 0);
                // Linux only; elsewhere the parent check below and the CLI's exit
                // closing the lane are what end the server.
                #[cfg(target_os = "linux")]
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
                if libc::getppid() != parent {
                    libc::_exit(0);
                }
                let null = libc::open(c"/dev/null".as_ptr(), libc::O_RDWR);
                if null >= 0 {
                    for fd in 0..3 {
                        libc::dup2(null, fd);
                    }
                }
            }
            relay.serve();
            loop {
                std::thread::park();
            }
        }
        _ => {
            drop(relay);
            // SAFETY: restoring the default disposition before the CLI starts.
            unsafe {
                libc::signal(libc::SIGPIPE, libc::SIG_DFL);
            }
            let error = std::process::Command::new(&command[0]).args(&command[1..]).exec();
            fail(&format!("could not start {}: {error}", command[0].to_string_lossy()), 127)
        }
    }
}

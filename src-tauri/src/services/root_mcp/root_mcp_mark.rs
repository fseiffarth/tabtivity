//! The stamp a local agent session carries about the MCP grant it was started
//! with, and the verdict a reattach draws from it (`docs/done/mcp_reattach_plan.md`).
//!
//! A local agent runs in its own tmux session. After a crash the session lives
//! on and the next launch only *reattaches* it (`tmux new-session -A`): the
//! agent keeps the MCP URLs and tokens it started with, which the new process
//! does not know. So at **creation** a session is stamped with a tmux user
//! option, `@<slug>_mcp = <nonce>:<grant>:<port>`:
//!
//! * `nonce`: random per listener (`Runtime::generation`), so a stamp from
//!   this very run is told from one a previous run (or the Mobile host) left;
//! * `grant`: the first lane's [`Session::id`](super::Session) (the SHA-256 of
//!   its token, never the token), or `-` when the spawn was granted nothing;
//! * `port`: the listener's port, which a *foreign* stamp's listener is asked
//!   on ([`probe_grant`]).
//!
//! [`classify_reattach`] turns the stamp and what this process holds into one
//! of four verdicts. It is pure; the probe and the store lookups are passed in.
//! `AppHandle`-free.

use std::io::{Read, Write};
use std::time::{Duration, Instant};

/// The tmux user option the stamp lives in.
pub const OPTION: &str = concat!("@", crate::app_slug!(), "_mcp");

/// How long the probe of a foreign listener may take, connect and answer
/// together: no answer is "stale", and a restore of many tabs must not stall.
pub const PROBE_TIMEOUT: Duration = Duration::from_millis(300);

/// A parsed stamp.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mark {
    pub nonce: String,
    /// `None`: the spawn was granted no lane.
    pub grant: Option<String>,
    pub port: u16,
}

/// A random listener nonce is this many hex characters.
const NONCE_LEN: usize = 32;
/// A grant id is a SHA-256 in hex.
const GRANT_LEN: usize = 64;

fn is_hex(text: &str, len: usize) -> bool {
    text.len() == len && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl Mark {
    /// The option value: `<nonce>:<grant or ->:<port>`.
    pub fn render(&self) -> String {
        format!("{}:{}:{}", self.nonce, self.grant.as_deref().unwrap_or("-"), self.port)
    }

    /// The stamp `text` holds, `None` for anything that is not exactly the
    /// shape [`Mark::render`] writes (a hand-set or garbled option reads as no
    /// stamp). The grant ends up in a URL, so only hex is accepted.
    pub fn parse(text: &str) -> Option<Mark> {
        let mut parts = text.trim().split(':');
        let (nonce, grant, port) = (parts.next()?, parts.next()?, parts.next()?);
        if parts.next().is_some() || !is_hex(nonce, NONCE_LEN) {
            return None;
        }
        let grant = match grant {
            "-" => None,
            hash if is_hex(hash, GRANT_LEN) => Some(hash.to_string()),
            _ => return None,
        };
        let port = port.parse::<u16>().ok().filter(|p| *p != 0)?;
        Some(Mark { nonce: nonce.to_string(), grant, port })
    }
}

/// A random listener nonce ([`NONCE_LEN`] hex characters). Without OS entropy
/// it falls back to the clock and pid: the nonce only tells runs apart, it
/// guards nothing (a token is never derived from it).
pub fn new_nonce() -> String {
    let mut bytes = [0u8; NONCE_LEN / 2];
    if getrandom::fill(&mut bytes).is_err() {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
        bytes.copy_from_slice(&(now ^ u128::from(std::process::id())).to_le_bytes());
    }
    crate::digest::hex(&bytes)
}

/// What a tab's local session looks like to a launch about to create-or-attach it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Stamp {
    /// No such session: the launch creates it.
    Absent,
    /// The backend cannot say (Windows without a session host answering, a
    /// failed listing): handled as a create, as before this stamp existed.
    Unknown,
    /// The session exists with no (or an unreadable) stamp: started by an
    /// older build, or by hand.
    Unmarked,
    Marked(Mark),
}

impl Stamp {
    /// The stamp for a session named in a listing: `entry` is the listing's
    /// row for it (`None`: not listed), holding the raw option value.
    pub fn of(entry: Option<&Option<String>>) -> Stamp {
        match entry {
            None => Stamp::Absent,
            Some(raw) => raw.as_deref().and_then(Mark::parse).map_or(Stamp::Unmarked, Stamp::Marked),
        }
    }
}

/// What a launch does about its MCP lanes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reattach {
    /// A new session: grant as ever and stamp it.
    Create,
    /// The running agent still holds a grant that works (this run's, or a
    /// listener that confirms it): mint nothing, so its tokens survive.
    Live,
    /// The running agent holds credentials nobody honours any more: mint
    /// nothing (the session ignores a new environment) and say so.
    Stale,
    /// The running agent was started with no grant: nothing was ever
    /// connected, so there is nothing to mint and nothing to report.
    NoGrant,
}

/// The verdict for a launch whose session looks like `stamp`.
///
/// * `own_nonce`, `own_port`: this process's listener nonce and port;
/// * `grant_held(id)`: this process's store still holds that session;
/// * `foreign_live(mark)`: the stamp's own listener (another process) confirms
///   its grant — asked only for a foreign stamp.
///
/// A foreign nonce on this listener's own port is a previous run of this very
/// listener: only this store can hold its grant (a revival,
/// `root_mcp_reattach`), so it is looked up here, never probed — the probe
/// would ask this listener itself and read `204` as "live elsewhere", with
/// nothing re-keyed.
pub fn classify_reattach(
    stamp: &Stamp,
    own_nonce: &str,
    own_port: u16,
    grant_held: impl FnOnce(&str) -> bool,
    foreign_live: impl FnOnce(&Mark) -> bool,
) -> Reattach {
    let mark = match stamp {
        Stamp::Absent | Stamp::Unknown => return Reattach::Create,
        Stamp::Unmarked => return Reattach::Stale,
        Stamp::Marked(mark) => mark,
    };
    let Some(grant) = mark.grant.as_deref() else { return Reattach::NoGrant };
    let live = if mark.nonce == own_nonce || mark.port == own_port { grant_held(grant) } else { foreign_live(mark) };
    if live { Reattach::Live } else { Reattach::Stale }
}

/// Ask the listener on loopback `port` whether it holds the grant `grant`
/// (`GET /mcp/grant/<hash>`: `204` held, anything else not). Blocking, bounded
/// by [`PROBE_TIMEOUT`] altogether; any failure reads as "not held". The route
/// is unauthenticated and answers nothing but that bit about a 256-bit hash.
pub fn probe_grant(port: u16, grant: &str) -> bool {
    if port == 0 || !is_hex(grant, GRANT_LEN) {
        return false;
    }
    probe_within(port, grant, PROBE_TIMEOUT).unwrap_or(false)
}

fn probe_within(port: u16, grant: &str, within: Duration) -> std::io::Result<bool> {
    let started = Instant::now();
    let left = || within.checked_sub(started.elapsed()).filter(|d| !d.is_zero()).ok_or(std::io::ErrorKind::TimedOut);
    let addr = std::net::SocketAddr::from((std::net::Ipv4Addr::LOCALHOST, port));
    let mut stream = std::net::TcpStream::connect_timeout(&addr, left()?)?;
    stream.set_write_timeout(Some(left()?))?;
    stream.write_all(
        format!("GET /mcp/grant/{grant} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n").as_bytes(),
    )?;
    // Only the status line matters: read until it is complete.
    let mut head = Vec::with_capacity(64);
    let mut chunk = [0u8; 64];
    while !head.contains(&b'\n') && head.len() < 256 {
        stream.set_read_timeout(Some(left()?))?;
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        head.extend_from_slice(&chunk[..n]);
    }
    let line = String::from_utf8_lossy(&head);
    let status = line.lines().next().unwrap_or("").split_whitespace().nth(1);
    Ok(status == Some("204"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONCE: &str = "0123456789abcdef0123456789abcdef";
    const OTHER: &str = "fedcba9876543210fedcba9876543210";
    const GRANT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn mark(nonce: &str, grant: Option<&str>) -> Mark {
        Mark { nonce: nonce.into(), grant: grant.map(str::to_string), port: 4242 }
    }

    #[test]
    fn a_stamp_round_trips_and_only_that_shape_parses() {
        for m in [mark(NONCE, Some(GRANT)), mark(NONCE, None)] {
            assert_eq!(Mark::parse(&m.render()), Some(m.clone()), "{}", m.render());
        }
        assert_eq!(mark(NONCE, None).render(), format!("{NONCE}:-:4242"));
        for bad in [
            "", "-", "x:y:z", &format!("{NONCE}:{GRANT}"), &format!("{NONCE}:{GRANT}:0"),
            &format!("{NONCE}:{GRANT}:70000"), &format!("{NONCE}:{GRANT}:1:2"), &format!("{NONCE}:{}:5", &GRANT[1..]),
            &format!("{NONCE}:{}:5", "G".repeat(64)), &format!("{}:{GRANT}:5", &NONCE[1..]),
            &format!("{NONCE}:../../etc:5"), &format!("{NONCE}:{GRANT}/x:5"),
        ] {
            assert_eq!(Mark::parse(bad), None, "{bad:?}");
        }
        assert_eq!(Mark::parse(&format!(" {NONCE}:-:7\n")).map(|m| m.port), Some(7), "tmux's trailing newline");
    }

    #[test]
    fn nonces_are_random_and_well_formed() {
        let (a, b) = (new_nonce(), new_nonce());
        assert!(is_hex(&a, NONCE_LEN) && is_hex(&b, NONCE_LEN));
        assert_ne!(a, b);
    }

    #[test]
    fn the_option_is_the_apps_own() {
        assert!(OPTION.starts_with('@') && OPTION.ends_with("_mcp"));
        assert_eq!(OPTION, format!("@{}_mcp", crate::app_slug!()));
    }

    #[test]
    fn stamps_read_off_a_listing() {
        assert_eq!(Stamp::of(None), Stamp::Absent);
        assert_eq!(Stamp::of(Some(&None)), Stamp::Unmarked);
        assert_eq!(Stamp::of(Some(&Some(String::new()))), Stamp::Unmarked);
        assert_eq!(Stamp::of(Some(&Some("garbage".into()))), Stamp::Unmarked);
        assert_eq!(Stamp::of(Some(&Some(mark(NONCE, None).render()))), Stamp::Marked(mark(NONCE, None)));
    }

    /// The whole table: stamp x (own grant held, foreign confirms).
    #[test]
    fn the_classifier_table() {
        let never = |_: &str| -> bool { panic!("asked when it must not be") };
        let never_foreign = |_: &Mark| -> bool { panic!("probed when it must not be") };
        use Reattach::*;
        const OWN_PORT: u16 = 5151;
        // No session / cannot tell: create, nothing asked.
        assert_eq!(classify_reattach(&Stamp::Absent, NONCE, OWN_PORT, never, never_foreign), Create);
        assert_eq!(classify_reattach(&Stamp::Unknown, NONCE, OWN_PORT, never, never_foreign), Create);
        // A session with no stamp: its credentials are unknown to us.
        assert_eq!(classify_reattach(&Stamp::Unmarked, NONCE, OWN_PORT, never, never_foreign), Stale);
        // Started with no grant: nothing to report, nothing asked.
        assert_eq!(classify_reattach(&Stamp::Marked(mark(NONCE, None)), NONCE, OWN_PORT, never, never_foreign), NoGrant);
        assert_eq!(classify_reattach(&Stamp::Marked(mark(OTHER, None)), NONCE, OWN_PORT, never, never_foreign), NoGrant);
        // This run's stamp: the store decides, the probe is never made.
        let own = Stamp::Marked(mark(NONCE, Some(GRANT)));
        assert_eq!(classify_reattach(&own, NONCE, OWN_PORT, |id| id == GRANT, never_foreign), Live);
        assert_eq!(classify_reattach(&own, NONCE, OWN_PORT, |_| false, never_foreign), Stale, "revoked or released since");
        // Another run's or process's stamp: only its listener can confirm it.
        let foreign = Stamp::Marked(mark(OTHER, Some(GRANT)));
        assert_eq!(classify_reattach(&foreign, NONCE, OWN_PORT, never, |m| m.port == 4242 && m.grant.as_deref() == Some(GRANT)), Live);
        assert_eq!(classify_reattach(&foreign, NONCE, OWN_PORT, never, |_| false), Stale, "dead listener, revoked grant or no answer");
        // A previous run of this listener (its port, another nonce): this
        // store decides, the probe would only ask this listener itself.
        assert_eq!(classify_reattach(&foreign, NONCE, 4242, |id| id == GRANT, never_foreign), Live, "revived here");
        assert_eq!(classify_reattach(&foreign, NONCE, 4242, |_| false, never_foreign), Stale);
    }

    /// A one-shot HTTP server answering with `status`, recording the request line.
    fn answer(status: &'static str) -> (u16, std::thread::JoinHandle<String>) {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let (mut conn, _) = listener.accept().unwrap();
            let mut buf = [0u8; 512];
            let n = conn.read(&mut buf).unwrap();
            let request = String::from_utf8_lossy(&buf[..n]).lines().next().unwrap_or("").to_string();
            conn.write_all(format!("HTTP/1.1 {status}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n").as_bytes()).unwrap();
            request
        });
        (port, handle)
    }

    #[test]
    fn the_probe_reads_204_as_held_and_anything_else_as_not() {
        let (port, server) = answer("204 No Content");
        assert!(probe_grant(port, GRANT));
        assert_eq!(server.join().unwrap(), format!("GET /mcp/grant/{GRANT} HTTP/1.1"));
        let (port, server) = answer("404 Not Found");
        assert!(!probe_grant(port, GRANT));
        server.join().unwrap();
        let (port, server) = answer("200 OK");
        assert!(!probe_grant(port, GRANT), "only 204 confirms");
        server.join().unwrap();
    }

    #[test]
    fn the_probe_is_bounded_and_refuses_what_is_not_a_grant() {
        // Accepts and never answers: the probe gives up within its bound.
        let silent = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = silent.local_addr().unwrap().port();
        let started = Instant::now();
        assert!(!probe_grant(port, GRANT));
        assert!(started.elapsed() < PROBE_TIMEOUT + Duration::from_millis(700), "{:?}", started.elapsed());
        drop(silent);
        // Nothing listening any more: refused at once.
        assert!(!probe_grant(port, GRANT));
        // Never a URL built from a stamp that is not a hash.
        assert!(!probe_grant(port, "../x"));
        assert!(!probe_grant(0, GRANT));
    }
}

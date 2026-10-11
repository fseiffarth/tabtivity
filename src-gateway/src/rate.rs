//! Rate limits for the gateway's own unauthenticated routes: pairing,
//! challenge and session (hosted plan §11, P3 review finding 12).
//!
//! The rule: **a request that names nobody the gateway knows can never use
//! up the budget of someone it does know.** So every request is first sorted
//! by what it names:
//!
//! - *strangers* — a pair for an account that is not a server user (or has
//!   no invite pending and no recent activity), a challenge/session for a
//!   device id no account owns. These are counted per source and in one
//!   shared stranger window, and never reach a daemon.
//! - *known* — a pair for a pairable account, a challenge/session for a
//!   paired device. These are counted per account (and per device), plus a
//!   separate server-wide ceiling against floods.
//!
//! **Sources.** Behind Tailscale Serve every TCP peer is `127.0.0.1`; Serve
//! sets `X-Forwarded-For` to the tailnet address it accepted (it drops what
//! the client sent and writes its own), so a loopback peer's rightmost
//! forwarded address is the source. A local account on the server can
//! connect to the loopback port directly and write any `X-Forwarded-For` it
//! likes — which is why the per-source windows guard only the stranger
//! paths and a pair's own source, never a known device's sign-in: forging
//! another device's source cannot lock that device out.
//!
//! Windows are fixed one-minute buckets; the keyed maps are bounded, and a
//! key that finds the map full shares one overflow window.

use std::collections::HashMap;
use std::time::{Duration, Instant};

const WINDOW: Duration = Duration::from_secs(60);
/// Keys a keyed window holds before new ones share the overflow window.
const MAX_KEYS: usize = 4096;

/// Pairs one source may send a minute.
pub const PAIR_PER_SOURCE: u32 = 10;
/// Pairs one account may receive a minute (its daemon also allows ten, and
/// an invite dies after five wrong codes).
pub const PAIR_PER_ACCOUNT: u32 = 20;
/// Pairs naming nobody pairable, all sources together.
pub const PAIR_STRANGERS: u32 = 60;
/// Pairs reaching any daemon, all accounts together.
pub const PAIR_KNOWN: u32 = 240;
/// Challenge/session calls for unknown device ids, per source.
pub const AUTH_PER_SOURCE: u32 = 60;
/// … and for unknown device ids from all sources together.
pub const AUTH_STRANGERS: u32 = 600;
/// Challenge/session calls one paired device may make a minute.
pub const AUTH_PER_DEVICE: u32 = 30;
/// … one account's devices together.
pub const AUTH_PER_ACCOUNT: u32 = 240;
/// … every paired device on the server together.
pub const AUTH_KNOWN: u32 = 4800;

#[derive(Debug, Clone, Copy)]
struct Window {
    started: Instant,
    count: u32,
}

impl Window {
    fn new(now: Instant) -> Self {
        Self { started: now, count: 0 }
    }

    fn stale(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.started) >= WINDOW
    }

    /// Count one; `false` once `limit` is passed inside the minute.
    fn admit(&mut self, limit: u32, now: Instant) -> bool {
        if self.stale(now) {
            *self = Window::new(now);
        }
        self.count = self.count.saturating_add(1);
        self.count <= limit
    }
}

/// One window per key, bounded.
struct Keyed {
    limit: u32,
    map: HashMap<String, Window>,
    overflow: Window,
}

impl Keyed {
    fn new(limit: u32, now: Instant) -> Self {
        Self { limit, map: HashMap::new(), overflow: Window::new(now) }
    }

    fn admit(&mut self, key: &str, now: Instant) -> bool {
        if let Some(window) = self.map.get_mut(key) {
            return window.admit(self.limit, now);
        }
        if self.map.len() >= MAX_KEYS {
            self.map.retain(|_, w| !w.stale(now));
        }
        if self.map.len() >= MAX_KEYS {
            return self.overflow.admit(self.limit, now);
        }
        let mut window = Window::new(now);
        let admitted = window.admit(self.limit, now);
        self.map.insert(key.to_string(), window);
        admitted
    }
}

/// Every window of the gateway's own routes.
pub struct Limits {
    pair_source: Keyed,
    pair_account: Keyed,
    pair_strangers: Window,
    pair_known: Window,
    auth_source: Keyed,
    auth_strangers: Window,
    auth_device: Keyed,
    auth_account: Keyed,
    auth_known: Window,
}

impl Limits {
    pub fn new(now: Instant) -> Self {
        Self {
            pair_source: Keyed::new(PAIR_PER_SOURCE, now),
            pair_account: Keyed::new(PAIR_PER_ACCOUNT, now),
            pair_strangers: Window::new(now),
            pair_known: Window::new(now),
            auth_source: Keyed::new(AUTH_PER_SOURCE, now),
            auth_strangers: Window::new(now),
            auth_device: Keyed::new(AUTH_PER_DEVICE, now),
            auth_account: Keyed::new(AUTH_PER_ACCOUNT, now),
            auth_known: Window::new(now),
        }
    }

    /// A pair that will not reach a daemon. The source is checked first, so
    /// one source cannot spend the shared window.
    pub fn pair_stranger(&mut self, source: &str, now: Instant) -> bool {
        self.pair_source.admit(source, now) && self.pair_strangers.admit(PAIR_STRANGERS, now)
    }

    /// A pair for a pairable account.
    pub fn pair_known(&mut self, source: &str, account: &str, now: Instant) -> bool {
        self.pair_source.admit(source, now) && self.pair_account.admit(account, now) && self.pair_known.admit(PAIR_KNOWN, now)
    }

    /// A challenge/session naming no paired device.
    pub fn auth_stranger(&mut self, source: &str, now: Instant) -> bool {
        self.auth_source.admit(source, now) && self.auth_strangers.admit(AUTH_STRANGERS, now)
    }

    /// A challenge/session of a paired device: never by source (a local
    /// account can forge one), only by device, account and the ceiling.
    pub fn auth_known(&mut self, device: &str, account: &str, now: Instant) -> bool {
        self.auth_device.admit(device, now) && self.auth_account.admit(account, now) && self.auth_known.admit(AUTH_KNOWN, now)
    }
}

/// The source of a request: the rightmost `X-Forwarded-For` address when
/// the TCP peer is loopback (Tailscale Serve's), else the peer itself.
/// `None` peer (a router served without connect info) counts as loopback.
pub fn source_of(peer: Option<std::net::SocketAddr>, forwarded_for: Option<&str>) -> String {
    let loopback = peer.is_none_or(|p| p.ip().is_loopback());
    if loopback {
        if let Some(last) = forwarded_for.and_then(|v| v.rsplit(',').next()).map(str::trim).filter(|s| !s.is_empty()) {
            if let Ok(ip) = last.parse::<std::net::IpAddr>() {
                return ip.to_string();
            }
        }
    }
    peer.map(|p| p.ip().to_string()).unwrap_or_else(|| "local".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strangers_never_spend_a_known_accounts_budget() {
        let now = Instant::now();
        let mut limits = Limits::new(now);
        // Every source on the tailnet floods pairs for nobody and sign-ins
        // for made-up devices until the stranger windows are shut.
        for n in 0..(PAIR_STRANGERS * 4) {
            limits.pair_stranger(&format!("2001:db8::{:x}", n % 250), now);
        }
        for n in 0..(AUTH_STRANGERS * 4) {
            limits.auth_stranger(&format!("2001:db8:1::{:x}", n % 250), now);
        }
        assert!(!limits.pair_stranger("192.0.2.99", now), "the stranger window is shut");
        assert!(!limits.auth_stranger("192.0.2.99", now));
        // Alice is untouched.
        assert!(limits.pair_known("192.0.2.21", "alice", now));
        assert!(limits.auth_known("alice_device_01", "alice", now));
    }

    #[test]
    fn one_source_cannot_shut_the_shared_window() {
        let now = Instant::now();
        let mut limits = Limits::new(now);
        for _ in 0..(PAIR_STRANGERS * 10) {
            limits.pair_stranger("192.0.2.1", now);
        }
        assert!(!limits.pair_stranger("192.0.2.1", now), "that source is limited");
        assert!(limits.pair_stranger("192.0.2.2", now), "another source still pairs");
        for _ in 0..(AUTH_STRANGERS * 10) {
            limits.auth_stranger("192.0.2.1", now);
        }
        assert!(limits.auth_stranger("192.0.2.2", now));
    }

    #[test]
    fn a_device_and_an_account_are_limited_on_their_own() {
        let now = Instant::now();
        let mut limits = Limits::new(now);
        for _ in 0..AUTH_PER_DEVICE {
            assert!(limits.auth_known("alice_device_01", "alice", now));
        }
        assert!(!limits.auth_known("alice_device_01", "alice", now), "that device is limited");
        assert!(limits.auth_known("alice_device_02", "alice", now), "Alice's other device is not");
        assert!(limits.auth_known("bob_device_0001", "bob", now), "Bob is not");
        for _ in 0..PAIR_PER_ACCOUNT {
            limits.pair_known(&format!("s{}", rand_suffix()), "alice", now);
        }
        assert!(!limits.pair_known("192.0.2.33", "alice", now), "Alice's pairing window is full");
        assert!(limits.pair_known("192.0.2.33", "bob", now), "Bob still pairs");
        // A minute later everything is open again.
        let later = now + WINDOW;
        assert!(limits.auth_known("alice_device_01", "alice", later));
        assert!(limits.pair_known("192.0.2.33", "alice", later));
    }

    fn rand_suffix() -> u32 {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        N.fetch_add(1, Ordering::Relaxed)
    }

    #[test]
    fn a_full_key_map_shares_one_overflow_window() {
        let now = Instant::now();
        let mut keyed = Keyed::new(2, now);
        for n in 0..MAX_KEYS {
            assert!(keyed.admit(&n.to_string(), now));
        }
        assert!(keyed.admit("new-1", now) && keyed.admit("new-2", now));
        assert!(!keyed.admit("new-3", now), "new keys share the overflow window");
        assert!(keyed.admit("0", now), "a known key keeps its own window");
        // Stale keys are swept before the overflow is used.
        let later = now + WINDOW;
        assert!(keyed.admit("new-4", later));
        assert!(keyed.map.len() < MAX_KEYS);
    }

    #[test]
    fn the_source_is_serves_forwarded_address_only_behind_loopback() {
        let loopback: std::net::SocketAddr = "127.0.0.1:5000".parse().unwrap();
        let remote: std::net::SocketAddr = "192.0.2.7:5000".parse().unwrap();
        assert_eq!(source_of(Some(loopback), Some("203.0.113.5")), "203.0.113.5");
        assert_eq!(source_of(Some(loopback), Some("198.51.100.1, 203.0.113.5")), "203.0.113.5", "the rightmost, the proxy's own");
        assert_eq!(source_of(Some(loopback), Some("not an address")), "127.0.0.1");
        assert_eq!(source_of(Some(remote), Some("203.0.113.5")), "192.0.2.7", "a direct peer cannot name another source");
        assert_eq!(source_of(None, None), "local");
    }
}

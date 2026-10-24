//! Who owns a loopback listener (threat-model recheck gap 50, Linux).
//!
//! A loopback port is shared by every account on the machine and, since the
//! agent fence keeps the host's network namespace, by every fenced agent too.
//! "Something answers on 127.0.0.1:N" is therefore not "the service I mean
//! answers there": whoever binds the port while the real service is down gets
//! what is sent to it. This module reads the owner of the listening socket
//! from `/proc/net/tcp{,6}` so a caller can judge the *owner*, not the
//! address. Three callers:
//!
//! * the Ollama transport and every "is it local?" gate (`commands::ollama`),
//!   through [`check`] and [`Policy`];
//! * the phone's OAuth-callback relay (`mobile_control::sign_in`), through
//!   [`own_targets`];
//! * the API proxy's remembered-port start (`api_proxy`), through [`check`].
//!
//! The parsing is pure and OS-independent; reading `/proc` is Linux only.
//! **macOS and Windows have no check**: [`check`] accepts there, so those
//! builds keep the address-only trust they had (a tracked residual, see
//! `docs/context/server_mode.md`). AppHandle-free and unit-testable.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

/// One socket in `LISTEN` state of a `/proc/net/tcp{,6}` table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Listener {
    pub ip: IpAddr,
    pub port: u16,
    pub uid: u32,
    pub inode: u64,
}

/// The listening sockets of one `/proc/net/tcp{,6}` table (`LISTEN` is `0A`).
pub fn listeners(table: &str) -> Vec<Listener> {
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
                Some(IpAddr::V6(Ipv6Addr::from(bytes)).to_canonical())
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
            Some(Listener {
                ip: ip_of(addr)?,
                port: u16::from_str_radix(port, 16).ok()?,
                uid: fields[7].parse().ok()?,
                inode: fields.get(9).and_then(|i| i.parse().ok()).unwrap_or(0),
            })
        })
        .collect()
}

/// Whether a listener bound to `bound` takes connections made to `target`:
/// the same address, or a wildcard. `::` is dual-stack unless the socket asked
/// for `IPV6_V6ONLY`, which `/proc` does not say, so it counts for IPv4 too —
/// the cautious reading for a check that refuses what it matches.
fn covers(bound: IpAddr, target: IpAddr) -> bool {
    bound == target || (bound.is_unspecified() && (bound.is_ipv6() || target.is_ipv4()))
}

/// The callback's targets whose listener belongs to `uid` (hosted plan
/// §5.1): on a server every user shares the loopback, so the relay hands a
/// code only to a listener of the caller's own uid — never to another
/// user's. A listener on the unspecified address counts for its family.
pub fn own_targets(targets: &[SocketAddr], uid: u32, tables: &[String]) -> Vec<SocketAddr> {
    let listening: Vec<Listener> = tables.iter().flat_map(|t| listeners(t)).collect();
    targets
        .iter()
        .copied()
        .filter(|target| listening.iter().any(|l| l.uid == uid && l.port == target.port() && covers(l.ip, target.ip())))
        .collect()
}

/// Whether any account listens where one of `targets` points.
pub fn is_listened_on(targets: &[SocketAddr], tables: &[String]) -> bool {
    let listening: Vec<Listener> = tables.iter().flat_map(|t| listeners(t)).collect();
    targets.iter().any(|target| listening.iter().any(|l| l.port == target.port() && covers(l.ip, target.ip())))
}

/// The `/proc/net/tcp{,6}` tables of this network namespace, unreadable ones
/// left out. Linux only; empty elsewhere.
pub fn read_tables() -> Vec<String> {
    #[cfg(target_os = "linux")]
    {
        ["/proc/net/tcp", "/proc/net/tcp6"].iter().filter_map(|p| std::fs::read_to_string(p).ok()).collect()
    }
    #[cfg(not(target_os = "linux"))]
    {
        Vec::new()
    }
}

// ── Whose listener is acceptable ────────────────────────────────────────────

/// Which listener owners count as "the service I mean". Decision D6 of the
/// recheck plan: the account's own uid (unless the listener sits in a fence),
/// root, a system account (below `SYS_UID_MAX`, which covers an `ollama`
/// service user) and one uid the user, or the hosted administrator, names. On
/// a hosted server the daemon's own uid is a *tenant*, not the service, so
/// there only root, system accounts and the administrator's named uid pass.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Policy {
    pub own_uid: u32,
    pub named_uid: Option<u32>,
    /// The highest uid that is a system account; `0` leaves only root.
    pub system_max: u32,
    pub server: bool,
}

impl Policy {
    /// This process's policy, with the uid the caller's configuration names
    /// (`Settings::ollama_listener_uid`, or the server policy file's).
    pub fn current(named_uid: Option<u32>) -> Policy {
        Policy { own_uid: own_uid(), named_uid, system_max: system_uid_max(), server: crate::services::server::is_server() }
    }
}

fn own_uid() -> u32 {
    #[cfg(unix)]
    {
        // SAFETY: getuid has no preconditions.
        unsafe { libc::getuid() }
    }
    #[cfg(not(unix))]
    {
        u32::MAX
    }
}

/// The highest system uid from `login.defs` text: `SYS_UID_MAX`, else just
/// under `UID_MIN` (default 1000), and never at or above `UID_MIN`. Pure.
pub fn system_uid_max_in(defs: &str) -> u32 {
    let value = |key: &str| {
        defs.lines()
            .filter_map(|line| {
                let mut words = line.split('#').next().unwrap_or("").split_whitespace();
                (words.next() == Some(key)).then(|| words.next().and_then(|v| v.parse::<u32>().ok())).flatten()
            })
            .next_back()
    };
    let uid_min = value("UID_MIN").filter(|m| *m > 0).unwrap_or(1000);
    value("SYS_UID_MAX").unwrap_or(uid_min - 1).min(uid_min - 1)
}

fn system_uid_max() -> u32 {
    static MAX: std::sync::OnceLock<u32> = std::sync::OnceLock::new();
    *MAX.get_or_init(|| system_uid_max_in(&std::fs::read_to_string("/etc/login.defs").unwrap_or_default()))
}

/// Where the processes holding an own-uid listener run, relative to this one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Placement {
    /// All in this process's pid namespace.
    Here,
    /// At least one in another pid namespace: a fence.
    Elsewhere,
    /// Not found, or not readable.
    Unknown,
}

/// Why a listener was not accepted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// Another account's.
    Other { uid: u32 },
    /// This account's, but inside another pid namespace — a fenced agent.
    Fenced,
    /// This account's, and its process could not be found to judge.
    Unknown,
}

impl Refusal {
    /// A sentence for the user, naming `endpoint` (`host:port`).
    pub fn describe(&self, endpoint: &str) -> String {
        match self {
            Refusal::Other { uid } => format!(
                "another account (uid {uid}) is listening on {endpoint}, not this account, root or a system service, so nothing is sent to it. \
                 If that is your server, name its uid in the settings (ollama_listener_uid)."
            ),
            Refusal::Fenced => format!(
                "a sandboxed process (an agent's, not a service you started) is listening on {endpoint}, so nothing is sent to it. \
                 Stop it, or start the server outside the sandbox."
            ),
            Refusal::Unknown => format!(
                "the process listening on {endpoint} could not be identified, so nothing is sent to it."
            ),
        }
    }
}

/// Judge one listener owner. `placement` is asked only for the account's own
/// uid. Pure.
pub fn judge(uid: u32, placement: impl FnOnce() -> Placement, policy: &Policy) -> Result<(), Refusal> {
    if !policy.server && uid == policy.own_uid {
        return match placement() {
            Placement::Here => Ok(()),
            Placement::Elsewhere => Err(Refusal::Fenced),
            Placement::Unknown => Err(Refusal::Unknown),
        };
    }
    if uid == 0 || uid <= policy.system_max || policy.named_uid == Some(uid) {
        Ok(())
    } else {
        Err(Refusal::Other { uid })
    }
}

/// The loopback addresses a connection to `host` may reach. `localhost` and
/// `*.localhost` are both families, as the system's resolver may pick either.
fn targets_of(host: &str) -> Vec<IpAddr> {
    match host.trim_matches(['[', ']']).parse::<IpAddr>() {
        Ok(ip) if ip.is_unspecified() => vec![if ip.is_ipv4() { Ipv4Addr::LOCALHOST.into() } else { Ipv6Addr::LOCALHOST.into() }],
        Ok(ip) => vec![ip],
        Err(_) => vec![Ipv4Addr::LOCALHOST.into(), Ipv6Addr::LOCALHOST.into()],
    }
}

/// [`check`] against given tables, with `placement` standing in for the
/// `/proc` walk. No listener at all is accepted: nothing to be fooled by, and
/// the caller's own connect decides. Pure.
pub fn check_in(
    tables: &[String],
    host: &str,
    port: u16,
    policy: &Policy,
    placement: &dyn Fn(u64) -> Placement,
) -> Result<(), Refusal> {
    let targets = targets_of(host);
    tables
        .iter()
        .flat_map(|t| listeners(t))
        .filter(|l| l.port == port && targets.iter().any(|t| covers(l.ip, *t)))
        .try_for_each(|l| judge(l.uid, || placement(l.inode), policy))
}

/// Whether every listener a connection to `host:port` could reach is
/// acceptable under `policy`. `trusted_pids` are processes this app started
/// itself (an `ollama serve` it spawned): a listener they hold passes even
/// where the pid-namespace test would not. Accepts everywhere but Linux.
pub fn check(host: &str, port: u16, policy: &Policy, trusted_pids: &[u32]) -> Result<(), Refusal> {
    #[cfg(target_os = "linux")]
    {
        check_in(&read_tables(), host, port, policy, &|inode| proc::placement_of(inode, trusted_pids))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (host, port, policy, trusted_pids);
        Ok(())
    }
}

#[cfg(target_os = "linux")]
mod proc {
    use super::Placement;
    use std::collections::HashMap;
    use std::os::unix::fs::MetadataExt;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    /// A process holding a listening socket.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct Held {
        pub pid: u32,
        /// In this process's pid namespace.
        pub here: bool,
        /// The file name of its executable, `(deleted)` marker dropped.
        pub exe: Option<String>,
    }

    /// A listener's holders are reused this long. The key is the socket's
    /// inode, which a new listener never shares, so a squatter that takes the
    /// port over is looked at afresh.
    const HOLDERS_TTL: Duration = Duration::from_secs(10);
    type Cache = HashMap<u64, (Instant, Vec<Held>)>;
    static HOLDERS: Mutex<Option<Cache>> = Mutex::new(None);

    /// The processes of this uid holding a descriptor on socket `inode`. Only
    /// this uid's processes are looked at: a listener of another uid is judged
    /// by the uid.
    fn walk(inode: u64) -> Vec<Held> {
        let needle = format!("socket:[{inode}]");
        let ours = std::fs::read_link("/proc/self/ns/pid").ok();
        // SAFETY: getuid has no preconditions.
        let uid = unsafe { libc::getuid() };
        let mut found = Vec::new();
        let Ok(entries) = std::fs::read_dir("/proc") else { return found };
        for entry in entries.flatten() {
            let Some(pid) = entry.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) else { continue };
            if entry.metadata().map(|m| m.uid()).ok() != Some(uid) {
                continue;
            }
            let Ok(fds) = std::fs::read_dir(entry.path().join("fd")) else { continue };
            let holds = fds.flatten().any(|fd| std::fs::read_link(fd.path()).is_ok_and(|t| t.as_os_str() == needle.as_str()));
            if holds {
                let theirs = std::fs::read_link(entry.path().join("ns/pid")).ok();
                let exe = std::fs::read_link(entry.path().join("exe")).ok().and_then(|p| {
                    let name = p.file_name()?.to_str()?.to_string();
                    Some(name.strip_suffix(" (deleted)").map(str::to_string).unwrap_or(name))
                });
                found.push(Held { pid, here: ours.is_some() && ours == theirs, exe });
            }
        }
        found
    }

    pub fn holders_of(inode: u64) -> Vec<Held> {
        if inode == 0 {
            return Vec::new();
        }
        let now = Instant::now();
        {
            let mut slot = HOLDERS.lock().unwrap_or_else(|p| p.into_inner());
            let map = slot.get_or_insert_with(HashMap::new);
            map.retain(|_, (at, _)| now.saturating_duration_since(*at) < HOLDERS_TTL);
            if let Some((_, held)) = map.get(&inode) {
                return held.clone();
            }
        }
        let found = walk(inode);
        if !found.is_empty() {
            HOLDERS.lock().unwrap_or_else(|p| p.into_inner()).get_or_insert_with(HashMap::new).insert(inode, (now, found.clone()));
        }
        found
    }

    pub fn placement_of(inode: u64, trusted_pids: &[u32]) -> Placement {
        let holders = holders_of(inode);
        if holders.is_empty() {
            Placement::Unknown
        } else if holders.iter().all(|h| h.here || trusted_pids.contains(&h.pid)) {
            Placement::Here
        } else {
            Placement::Elsewhere
        }
    }
}

/// One process-side view of a listener on a loopback port, for a caller that
/// wants to know *who* holds it rather than whether to trust it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Occupant {
    pub uid: u32,
    /// This account's, in another pid namespace (a fenced agent).
    pub fenced: bool,
    /// This account's, in this pid namespace, running the same program as this
    /// process — another instance of the app. Never true for anyone else's.
    pub same_program: bool,
    /// Whether the holding processes were found (always false for another
    /// account's, which are not looked at).
    pub identified: bool,
}

/// The listeners a connection to `127.0.0.1:port` could reach. Empty when none
/// is found, and everywhere but Linux.
pub fn occupants(port: u16) -> Vec<Occupant> {
    #[cfg(target_os = "linux")]
    {
        let own = own_uid();
        let me = std::env::current_exe().ok().and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()));
        let targets = [IpAddr::from(Ipv4Addr::LOCALHOST)];
        read_tables()
            .iter()
            .flat_map(|t| listeners(t))
            .filter(|l| l.port == port && targets.iter().any(|t| covers(l.ip, *t)))
            .map(|l| {
                let held = if l.uid == own { proc::holders_of(l.inode) } else { Vec::new() };
                Occupant {
                    uid: l.uid,
                    fenced: held.iter().any(|h| !h.here),
                    same_program: !held.is_empty() && held.iter().all(|h| h.here && h.exe.is_some() && h.exe == me),
                    identified: !held.is_empty(),
                }
            })
            .collect()
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = port;
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const V4: &str = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n\
   0: 0100007F:2CAA 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 5001 1 0000000000000000 100 0 0 10 0\n\
   1: 00000000:1F95 00000000:0000 0A 00000000:00000000 00:00000000 00000000   110        0 5002 1 0000000000000000 100 0 0 10 0\n\
   2: 0100007F:0BB8 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1001        0 5003 1 0000000000000000 100 0 0 10 0\n";
    const V6: &str = "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n\
   0: 00000000000000000000000001000000:2CAA 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1002        0 5004 1 0000000000000000 100 0 0 10 0\n\
   1: 00000000000000000000000000000000:3039 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 5005 1 0000000000000000 100 0 0 10 0\n\
   2: 0000000000000000FFFF00000100007F:3A98 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 5006 1 0000000000000000 100 0 0 10 0\n";

    fn policy() -> Policy {
        Policy { own_uid: 1001, named_uid: None, system_max: 999, server: false }
    }

    #[test]
    fn parses_listeners_with_their_owner_and_inode() {
        let found = listeners(V4);
        assert_eq!(found.len(), 2, "the connected socket is no listener");
        assert_eq!(found[0], Listener { ip: Ipv4Addr::LOCALHOST.into(), port: 11434, uid: 1001, inode: 5001 });
        assert_eq!(found[1].port, 8085);
        let six = listeners(V6);
        assert_eq!(six[0], Listener { ip: Ipv6Addr::LOCALHOST.into(), port: 11434, uid: 1002, inode: 5004 });
        assert!(six[1].ip.is_unspecified());
        assert_eq!(six[2].ip, IpAddr::V4(Ipv4Addr::LOCALHOST), "a mapped address is the v4 one");
    }

    #[test]
    fn a_listener_covers_its_own_address_and_wildcards() {
        let v4: IpAddr = Ipv4Addr::LOCALHOST.into();
        let v6: IpAddr = Ipv6Addr::LOCALHOST.into();
        assert!(covers(v4, v4) && covers(v6, v6) && !covers(v4, v6) && !covers(v6, v4));
        assert!(covers(Ipv4Addr::UNSPECIFIED.into(), v4) && !covers(Ipv4Addr::UNSPECIFIED.into(), v6));
        assert!(covers(Ipv6Addr::UNSPECIFIED.into(), v6) && covers(Ipv6Addr::UNSPECIFIED.into(), v4), "dual stack");
    }

    #[test]
    fn only_the_callers_own_listener_gets_the_code() {
        let tables = [V4.to_string(), V6.to_string()];
        let both = ["127.0.0.1:11434".parse().unwrap(), "[::1]:11434".parse().unwrap()];
        assert_eq!(own_targets(&both, 1001, &tables), vec![both[0]]);
        assert_eq!(own_targets(&both, 1002, &tables), vec![both[1]]);
        assert!(own_targets(&both, 1003, &tables).is_empty(), "nobody else's listener");
        let any: [SocketAddr; 1] = ["127.0.0.1:8085".parse().unwrap()];
        assert_eq!(own_targets(&any, 110, &tables).len(), 1, "an unspecified-address listener counts");
        assert!(own_targets(&any, 1002, &tables).is_empty());
        let dual: [SocketAddr; 1] = ["127.0.0.1:12345".parse().unwrap()];
        assert_eq!(own_targets(&dual, 1001, &tables).len(), 1, "`::` also takes v4");
    }

    #[test]
    fn reads_the_system_uid_range_from_login_defs() {
        assert_eq!(system_uid_max_in(""), 999);
        assert_eq!(system_uid_max_in("UID_MIN 500\n"), 499);
        assert_eq!(system_uid_max_in("# SYS_UID_MAX 100\nSYS_UID_MAX   800 # note\nUID_MIN 1000\n"), 800);
        assert_eq!(system_uid_max_in("SYS_UID_MAX 5000\nUID_MIN 1000\n"), 999, "never into the login range");
        assert_eq!(system_uid_max_in("UID_MIN 0\n"), 999);
    }

    #[test]
    fn judges_owners_by_the_decided_rules() {
        let here = || Placement::Here;
        let p = policy();
        assert_eq!(judge(1001, here, &p), Ok(()), "own uid, not in a fence");
        assert_eq!(judge(1001, || Placement::Elsewhere, &p), Err(Refusal::Fenced));
        assert_eq!(judge(1001, || Placement::Unknown, &p), Err(Refusal::Unknown));
        assert_eq!(judge(0, || unreachable!(), &p), Ok(()), "root");
        assert_eq!(judge(110, || unreachable!(), &p), Ok(()), "the ollama service user");
        assert_eq!(judge(999, || unreachable!(), &p), Ok(()));
        assert_eq!(judge(1002, here, &p), Err(Refusal::Other { uid: 1002 }));
        assert_eq!(judge(65534, here, &p), Err(Refusal::Other { uid: 65534 }), "nobody is not a service");
        let named = Policy { named_uid: Some(1002), ..p.clone() };
        assert_eq!(judge(1002, || unreachable!(), &named), Ok(()));
        let own_named = Policy { named_uid: Some(1001), ..p.clone() };
        assert_eq!(judge(1001, || Placement::Elsewhere, &own_named), Err(Refusal::Fenced), "naming your own uid does not lift the fence rule");
        let low_own = Policy { own_uid: 500, system_max: 999, ..p.clone() };
        assert_eq!(judge(500, || Placement::Elsewhere, &low_own), Err(Refusal::Fenced), "a low own uid is still own");
        let server = Policy { server: true, ..p.clone() };
        assert_eq!(judge(1001, here, &server), Err(Refusal::Other { uid: 1001 }), "a tenant is not the service");
        assert_eq!(judge(110, here, &server), Ok(()));
        assert_eq!(judge(1500, here, &Policy { named_uid: Some(1500), ..server }), Ok(()), "the administrator's");
    }

    #[test]
    fn checks_every_listener_a_connection_could_reach() {
        let tables = [V4.to_string(), V6.to_string()];
        let p = policy();
        let here = |_: u64| Placement::Here;
        // 11434: 127.0.0.1 is uid 1001 (own), ::1 is uid 1002 (another account).
        assert_eq!(check_in(&tables, "127.0.0.1", 11434, &p, &here), Ok(()));
        assert_eq!(check_in(&tables, "::1", 11434, &p, &here), Err(Refusal::Other { uid: 1002 }));
        assert_eq!(check_in(&tables, "localhost", 11434, &p, &here), Err(Refusal::Other { uid: 1002 }), "either family may answer");
        assert_eq!(check_in(&tables, "localhost", 11434, &p, &|_| Placement::Elsewhere), Err(Refusal::Fenced));
        assert_eq!(check_in(&tables, "0.0.0.0", 8085, &p, &here), Ok(()), "a system account's wildcard listener");
        assert_eq!(check_in(&tables, "127.0.0.1", 9, &p, &here), Ok(()), "no listener, nothing to refuse");
        assert!(Refusal::Fenced.describe("127.0.0.1:11434").contains("127.0.0.1:11434"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn finds_this_processs_own_listener_in_its_own_namespace() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let p = Policy::current(None);
        assert_eq!(check("127.0.0.1", port, &p, &[]), Ok(()));
        // The same listener, but this process's pid namespace is pretended away.
        let theirs: Vec<Listener> = listeners(&read_tables().join("\n")).into_iter().filter(|l| l.port == port).collect();
        assert_eq!(theirs.len(), 1);
        assert_eq!(proc::placement_of(theirs[0].inode, &[]), Placement::Here);
        assert_eq!(proc::placement_of(u64::MAX - 1, &[]), Placement::Unknown, "no holder is not a pass");
        let seen = occupants(port);
        assert_eq!(seen, vec![Occupant { uid: own_uid(), fenced: false, same_program: true, identified: true }]);
        assert!(occupants(1).is_empty());
    }
}

//! Read-only network monitoring for project tabs.
//!
//! A local project observes the local host (`/proc` on Linux, `GetIfTable2` +
//! the extended TCP/UDP tables on Windows, `netstat` on macOS). A remote project
//! observes its SSH host by riding the already-authenticated ControlMaster; it
//! never opens a connection on its own. The separate SSH-link snapshot is
//! collected locally from the ControlMaster's own socket counters — `ss` on
//! Linux, `nettop` on macOS — so it includes every multiplexed channel
//! (terminal, SFTP, sync, git). Windows OpenSSH has no ControlMaster, so there
//! is no shared link to measure there.

#[cfg(target_os = "linux")]
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::State;

use crate::services::remote::{self, RemotePoolState};

const REMOTE_IFACES: &str = concat!("test -r /proc/net/dev || exit 42; \
printf '__", crate::app_upper!(), "_IFACES__\\n'; cat /proc/net/dev; \
printf '__", crate::app_upper!(), "_STATES__\\n'; \
for p in /sys/class/net/*; do test -e \"$p\" || continue; \
printf '%s ' \"${p##*/}\"; cat \"$p/operstate\" 2>/dev/null || printf 'unknown\\n'; done");
const REMOTE_WITH_CONNECTIONS: &str = concat!("test -r /proc/net/dev || exit 42; \
printf '__", crate::app_upper!(), "_IFACES__\\n'; cat /proc/net/dev; \
printf '__", crate::app_upper!(), "_STATES__\\n'; \
for p in /sys/class/net/*; do test -e \"$p\" || continue; \
printf '%s ' \"${p##*/}\"; cat \"$p/operstate\" 2>/dev/null || printf 'unknown\\n'; done; \
printf '__", crate::app_upper!(), "_CONNECTIONS__\\n'; \
if command -v ss >/dev/null 2>&1; then LC_ALL=C ss -H -tuna -p 2>/dev/null || true; \
else printf '__", crate::app_upper!(), "_NO_SS__\\n'; fi");

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInterface {
    pub name: String,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    pub up: bool,
    pub loopback: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkConnection {
    pub protocol: String,
    pub state: String,
    pub local_address: String,
    pub local_port: String,
    pub remote_address: String,
    pub remote_port: String,
    pub pid: Option<u32>,
    pub process: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkHostSnapshot {
    pub supported: bool,
    pub remote: bool,
    pub connected: bool,
    pub sampled_at_ms: u64,
    pub host_label: String,
    pub interfaces: Vec<NetworkInterface>,
    pub connections: Option<Vec<NetworkConnection>>,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshLinkSnapshot {
    pub supported: bool,
    pub connected: bool,
    pub sampled_at_ms: u64,
    pub connection_id: Option<String>,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    pub local_endpoint: Option<String>,
    pub remote_endpoint: Option<String>,
    pub warning: Option<String>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn unsupported_host(
    remote: bool,
    connected: bool,
    host_label: String,
    warning: &str,
) -> NetworkHostSnapshot {
    NetworkHostSnapshot {
        supported: false,
        remote,
        connected,
        sampled_at_ms: now_ms(),
        host_label,
        interfaces: Vec::new(),
        connections: None,
        warning: Some(warning.to_string()),
    }
}

fn split_endpoint(value: &str) -> (String, String) {
    let value = value.trim();
    if let Some(rest) = value.strip_prefix('[') {
        if let Some((address, port)) = rest.rsplit_once("]:") {
            return (address.to_string(), port.to_string());
        }
    }
    value
        .rsplit_once(':')
        .map(|(address, port)| (address.to_string(), port.to_string()))
        .unwrap_or_else(|| (value.to_string(), String::new()))
}

fn process_meta(text: &str) -> (Option<u32>, Option<String>) {
    let pid = text
        .find("pid=")
        .and_then(|start| {
            text[start + 4..]
                .split(|c: char| !c.is_ascii_digit())
                .next()
        })
        .and_then(|v| v.parse().ok());
    let process = text
        .find("((\"")
        .and_then(|start| {
            let tail = &text[start + 3..];
            tail.find('"').map(|end| tail[..end].to_string())
        })
        .filter(|v| !v.is_empty());
    (pid, process)
}

fn parse_interfaces(text: &str) -> Vec<NetworkInterface> {
    text.lines()
        .filter_map(|line| {
            let (name, counters) = line.rsplit_once(':')?;
            let name = name.trim();
            if name.is_empty() || name == "Inter-| Receive" {
                return None;
            }
            let fields: Vec<&str> = counters.split_whitespace().collect();
            let rx_bytes = fields.first()?.parse().ok()?;
            let tx_bytes = fields.get(8)?.parse().ok()?;
            Some(NetworkInterface {
                name: name.to_string(),
                rx_bytes,
                tx_bytes,
                // Remote snapshots do not make an extra round trip for operstate.
                // An interface present in /proc is selectable; the local path
                // replaces this with the kernel's current state below.
                up: true,
                loopback: name == "lo",
            })
        })
        .collect()
}

fn parse_connections(text: &str) -> Vec<NetworkConnection> {
    text.lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() < 6 {
                return None;
            }
            let protocol = fields[0].to_ascii_uppercase();
            if protocol != "TCP" && protocol != "UDP" {
                return None;
            }
            let (local_address, local_port) = split_endpoint(fields[4]);
            let (remote_address, remote_port) = split_endpoint(fields[5]);
            let meta = fields.get(6..).unwrap_or_default().join(" ");
            let (pid, process) = process_meta(&meta);
            Some(NetworkConnection {
                protocol,
                state: fields[1].to_string(),
                local_address,
                local_port,
                remote_address,
                remote_port,
                pid,
                process,
            })
        })
        .collect()
}

fn parse_remote_snapshot(
    output: &str,
    host_label: String,
    include_connections: bool,
) -> NetworkHostSnapshot {
    let Some(after_ifaces) = output.split_once(concat!("__", crate::app_upper!(), "_IFACES__\n")).map(|(_, v)| v) else {
        return unsupported_host(
            true,
            true,
            host_label,
            "The SSH host does not expose Linux /proc network counters.",
        );
    };
    let (iface_text, after_states) = after_ifaces
        .split_once(concat!("__", crate::app_upper!(), "_STATES__\n"))
        .unwrap_or((after_ifaces, ""));
    let (state_text, connection_text) = after_states
        .split_once(concat!("__", crate::app_upper!(), "_CONNECTIONS__\n"))
        .map(|(a, b)| (a, Some(b)))
        .unwrap_or((after_states, None));
    let states: std::collections::HashMap<&str, &str> = state_text
        .lines()
        .filter_map(|line| line.split_once(' '))
        .map(|(name, state)| (name.trim(), state.trim()))
        .collect();
    let mut interfaces = parse_interfaces(iface_text);
    for iface in &mut interfaces {
        iface.up = states
            .get(iface.name.as_str())
            .map(|state| matches!(*state, "up" | "unknown"))
            .unwrap_or(true);
    }
    if interfaces.is_empty() {
        return unsupported_host(
            true,
            true,
            host_label,
            "No Linux network interfaces were available on the SSH host.",
        );
    }
    let no_ss = connection_text.is_some_and(|v| v.contains(concat!("__", crate::app_upper!(), "_NO_SS__")));
    NetworkHostSnapshot {
        supported: true,
        remote: true,
        connected: true,
        sampled_at_ms: now_ms(),
        host_label,
        interfaces,
        connections: if include_connections && !no_ss {
            Some(parse_connections(connection_text.unwrap_or_default()))
        } else {
            None
        },
        warning: no_ss.then(|| {
            "`ss` is unavailable on the SSH host; connection details are hidden.".to_string()
        }),
    }
}

#[cfg(target_os = "linux")]
fn local_snapshot(include_connections: bool) -> NetworkHostSnapshot {
    let proc_net = match std::fs::read_to_string("/proc/net/dev") {
        Ok(v) => v,
        Err(e) => {
            return unsupported_host(
                false,
                true,
                "Local host".to_string(),
                &format!("Cannot read /proc/net/dev: {e}"),
            );
        }
    };
    let mut interfaces = parse_interfaces(&proc_net);
    for iface in &mut interfaces {
        iface.up = std::fs::read_to_string(format!("/sys/class/net/{}/operstate", iface.name))
            .map(|v| matches!(v.trim(), "up" | "unknown"))
            .unwrap_or(true);
    }

    let (connections, warning) = if include_connections {
        match crate::paths::command_no_window("ss")
            .args(["-H", "-tuna", "-p"])
            .env("LC_ALL", "C")
            .output()
        {
            Ok(out) if out.status.success() => (
                Some(parse_connections(&String::from_utf8_lossy(&out.stdout))),
                None,
            ),
            Ok(out) => {
                let message = String::from_utf8_lossy(&out.stderr).trim().to_string();
                (
                    None,
                    Some(if message.is_empty() {
                        "`ss` could not list connections.".to_string()
                    } else {
                        message
                    }),
                )
            }
            Err(_) => (
                None,
                Some("`ss` is unavailable; connection details are hidden.".to_string()),
            ),
        }
    } else {
        (None, None)
    };

    NetworkHostSnapshot {
        supported: true,
        remote: false,
        connected: true,
        sampled_at_ms: now_ms(),
        host_label: "Local host".to_string(),
        interfaces,
        connections,
        warning,
    }
}

/// Decode a NUL-terminated UTF-16 buffer (a `MIB_IF_ROW2.Alias`) to a String.
#[cfg(any(target_os = "windows", test))]
fn utf16_nul_to_string(units: &[u16]) -> String {
    let len = units.iter().position(|&u| u == 0).unwrap_or(units.len());
    String::from_utf16_lossy(&units[..len])
}

/// `MIB_TCP_STATE` → the name `ss` would print, so the pane's state column
/// reads the same for a local Windows host as for a Linux one.
#[cfg(any(target_os = "windows", test))]
fn tcp_state_name(state: u32) -> &'static str {
    match state {
        1 => "CLOSED",
        2 => "LISTEN",
        3 => "SYN-SENT",
        4 => "SYN-RECV",
        5 => "ESTAB",
        6 => "FIN-WAIT-1",
        7 => "FIN-WAIT-2",
        8 => "CLOSE-WAIT",
        9 => "CLOSING",
        10 => "LAST-ACK",
        11 => "TIME-WAIT",
        12 => "DELETE-TCB",
        _ => "UNKNOWN",
    }
}

/// A `dwLocalPort`-style field: the port sits in the low 16 bits, in network
/// byte order.
#[cfg(any(target_os = "windows", test))]
fn mib_port(raw: u32) -> String {
    u16::from_be((raw & 0xFFFF) as u16).to_string()
}

/// Every TCP and UDP socket with its owning pid, via the IP Helper extended
/// tables (`GetExtendedTcpTable` / `GetExtendedUdpTable`, IPv4 and IPv6). The
/// process name comes from the owner's image path. Empty (never an error) when
/// a table cannot be read.
#[cfg(target_os = "windows")]
fn windows_connections() -> Vec<NetworkConnection> {
    use std::collections::HashMap;
    use windows::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, GetExtendedUdpTable, MIB_TCP6ROW_OWNER_PID,
        MIB_TCP6TABLE_OWNER_PID, MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID,
        MIB_UDP6ROW_OWNER_PID, MIB_UDP6TABLE_OWNER_PID, MIB_UDPROW_OWNER_PID,
        MIB_UDPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_ALL, UDP_TABLE_OWNER_PID,
    };

    const AF_INET: u32 = 2;
    const AF_INET6: u32 = 23;
    const NO_ERROR: u32 = 0;
    const ERROR_INSUFFICIENT_BUFFER: u32 = 122;

    /// Size-then-fill an extended table into a byte buffer.
    fn fetch(read: impl Fn(Option<*mut core::ffi::c_void>, &mut u32) -> u32) -> Option<Vec<u8>> {
        let mut size: u32 = 0;
        let rc = read(None, &mut size);
        if rc != ERROR_INSUFFICIENT_BUFFER && rc != NO_ERROR {
            return None;
        }
        if size == 0 {
            return None;
        }
        // Room for a few sockets that appear between the two calls.
        let mut buf = vec![0u8; size as usize + 4096];
        let mut size = buf.len() as u32;
        let rc = read(Some(buf.as_mut_ptr() as *mut core::ffi::c_void), &mut size);
        (rc == NO_ERROR).then_some(buf)
    }

    /// The rows of a `MIB_*TABLE_OWNER_PID` buffer, bounded by the buffer's
    /// real length regardless of what the header's `dwNumEntries` claims.
    ///
    /// # Safety
    /// `buf` must have been filled by the `Get*Table` call whose layout `T`
    /// names, and `first` must return the address of that table's `table[0]`.
    unsafe fn rows<T, R: Copy>(buf: &[u8], first: unsafe fn(*const T) -> *const R) -> &[R] {
        let table = buf.as_ptr() as *const T;
        let count = *(buf.as_ptr() as *const u32) as usize;
        let start = first(table);
        let offset = start as usize - buf.as_ptr() as usize;
        let fit = (buf.len().saturating_sub(offset)) / std::mem::size_of::<R>();
        std::slice::from_raw_parts(start, count.min(fit))
    }

    let mut names: HashMap<u32, Option<String>> = HashMap::new();
    let mut name_of = |pid: u32| -> Option<String> {
        names
            .entry(pid)
            .or_insert_with(|| {
                crate::sysstat::cmdline(pid).map(|path| {
                    path.rsplit(['\\', '/'])
                        .next()
                        .unwrap_or(&path)
                        .trim_end_matches(".exe")
                        .to_string()
                })
            })
            .clone()
    };
    let mut out = Vec::new();

    // SAFETY: each buffer was filled by the matching Get*Table call and is
    // read as the table layout that call documents; `rows` bounds the slice by
    // the buffer's length, never only by the header count.
    unsafe {
        if let Some(buf) = fetch(|p, n| GetExtendedTcpTable(p, n, false, AF_INET, TCP_TABLE_OWNER_PID_ALL, 0)) {
            for row in rows::<MIB_TCPTABLE_OWNER_PID, MIB_TCPROW_OWNER_PID>(&buf, |t| (*t).table.as_ptr()) {
                out.push(NetworkConnection {
                    protocol: "TCP".into(),
                    state: tcp_state_name(row.dwState).into(),
                    local_address: std::net::Ipv4Addr::from(u32::from_be(row.dwLocalAddr)).to_string(),
                    local_port: mib_port(row.dwLocalPort),
                    remote_address: std::net::Ipv4Addr::from(u32::from_be(row.dwRemoteAddr)).to_string(),
                    remote_port: mib_port(row.dwRemotePort),
                    pid: Some(row.dwOwningPid),
                    process: name_of(row.dwOwningPid),
                });
            }
        }
        if let Some(buf) = fetch(|p, n| GetExtendedTcpTable(p, n, false, AF_INET6, TCP_TABLE_OWNER_PID_ALL, 0)) {
            for row in rows::<MIB_TCP6TABLE_OWNER_PID, MIB_TCP6ROW_OWNER_PID>(&buf, |t| (*t).table.as_ptr()) {
                out.push(NetworkConnection {
                    protocol: "TCP".into(),
                    state: tcp_state_name(row.dwState).into(),
                    local_address: std::net::Ipv6Addr::from(row.ucLocalAddr).to_string(),
                    local_port: mib_port(row.dwLocalPort),
                    remote_address: std::net::Ipv6Addr::from(row.ucRemoteAddr).to_string(),
                    remote_port: mib_port(row.dwRemotePort),
                    pid: Some(row.dwOwningPid),
                    process: name_of(row.dwOwningPid),
                });
            }
        }
        if let Some(buf) = fetch(|p, n| GetExtendedUdpTable(p, n, false, AF_INET, UDP_TABLE_OWNER_PID, 0)) {
            for row in rows::<MIB_UDPTABLE_OWNER_PID, MIB_UDPROW_OWNER_PID>(&buf, |t| (*t).table.as_ptr()) {
                out.push(NetworkConnection {
                    protocol: "UDP".into(),
                    state: "UNCONN".into(),
                    local_address: std::net::Ipv4Addr::from(u32::from_be(row.dwLocalAddr)).to_string(),
                    local_port: mib_port(row.dwLocalPort),
                    remote_address: "*".into(),
                    remote_port: "*".into(),
                    pid: Some(row.dwOwningPid),
                    process: name_of(row.dwOwningPid),
                });
            }
        }
        if let Some(buf) = fetch(|p, n| GetExtendedUdpTable(p, n, false, AF_INET6, UDP_TABLE_OWNER_PID, 0)) {
            for row in rows::<MIB_UDP6TABLE_OWNER_PID, MIB_UDP6ROW_OWNER_PID>(&buf, |t| (*t).table.as_ptr()) {
                out.push(NetworkConnection {
                    protocol: "UDP".into(),
                    state: "UNCONN".into(),
                    local_address: std::net::Ipv6Addr::from(row.ucLocalAddr).to_string(),
                    local_port: mib_port(row.dwLocalPort),
                    remote_address: "*".into(),
                    remote_port: "*".into(),
                    pid: Some(row.dwOwningPid),
                    process: name_of(row.dwOwningPid),
                });
            }
        }
    }
    out
}

/// Local interface counters via `GetIfTable2`; connection details via the IP
/// Helper extended tables ([`windows_connections`]).
#[cfg(target_os = "windows")]
fn local_snapshot(include_connections: bool) -> NetworkHostSnapshot {
    use windows::Win32::NetworkManagement::IpHelper::{FreeMibTable, GetIfTable2, MIB_IF_TABLE2};
    use windows::Win32::NetworkManagement::Ndis::IfOperStatusUp;

    /// IANA ifType 24 = softwareLoopback (`IF_TYPE_SOFTWARE_LOOPBACK`).
    const IF_TYPE_SOFTWARE_LOOPBACK: u32 = 24;

    let mut table: *mut MIB_IF_TABLE2 = std::ptr::null_mut();
    // SAFETY: GetIfTable2 allocates the table it points `table` at; it is read
    // within NumEntries bounds and released with FreeMibTable on every path
    // where it was set.
    let interfaces = unsafe {
        if GetIfTable2(&mut table).is_err() || table.is_null() {
            Vec::new()
        } else {
            let rows =
                std::slice::from_raw_parts((*table).Table.as_ptr(), (*table).NumEntries as usize);
            let interfaces = rows
                .iter()
                .filter_map(|row| {
                    let name = utf16_nul_to_string(&row.Alias);
                    // Skip alias-less rows (filter/lightweight interfaces); a
                    // user-visible adapter always carries an alias.
                    if name.is_empty() {
                        return None;
                    }
                    Some(NetworkInterface {
                        name,
                        rx_bytes: row.InOctets,
                        tx_bytes: row.OutOctets,
                        up: row.OperStatus == IfOperStatusUp,
                        loopback: row.Type == IF_TYPE_SOFTWARE_LOOPBACK,
                    })
                })
                .collect();
            FreeMibTable(table as *const core::ffi::c_void);
            interfaces
        }
    };
    if interfaces.is_empty() {
        return unsupported_host(
            false,
            true,
            "Local host".to_string(),
            "No network interfaces could be enumerated.",
        );
    }
    NetworkHostSnapshot {
        supported: true,
        remote: false,
        connected: true,
        sampled_at_ms: now_ms(),
        host_label: "Local host".to_string(),
        interfaces,
        connections: include_connections.then(windows_connections),
        warning: None,
    }
}

/// Parse `netstat -ibn` output into per-interface byte counters. Only the
/// `<Link#N>` rows are interface totals (per-address rows repeat the counters
/// per bound address and carry no `<Link#…>` cell). The Address column is
/// EMPTY for some link rows (`lo0`, `gif0`, …), so columns are indexed from
/// the END of the row: … Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll — Ibytes
/// is `len-5` and Obytes `len-2`. Loopback = name starts with "lo"; operstate
/// isn't in this output, so `up` stays true (an interface present in the
/// table is selectable — same convention as the remote /proc path).
#[cfg(any(target_os = "macos", test))]
fn parse_netstat_ibn(text: &str) -> Vec<NetworkInterface> {
    text.lines()
        .filter_map(|line| {
            if !line.contains("<Link#") {
                return None;
            }
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() < 8 {
                return None;
            }
            let name = *fields.first()?;
            let rx_bytes = fields.get(fields.len() - 5)?.parse().ok()?;
            let tx_bytes = fields.get(fields.len() - 2)?.parse().ok()?;
            Some(NetworkInterface {
                name: name.to_string(),
                rx_bytes,
                tx_bytes,
                up: true,
                loopback: name.starts_with("lo"),
            })
        })
        .collect()
}

/// Parse `netstat -anv -p tcp` / `-p udp` (macOS) into connections. `-v` adds
/// the owning pid; the row shapes are
///
/// ```text
/// tcp4  0  0  198.51.100.5.52000  203.0.113.4.22  ESTABLISHED  131072 131072  842  0 …
/// udp4  0  0  *.5353             *.*                      196724 9216    311  0 …
/// ```
///
/// TCP rows carry a state cell and the pid is the ninth field; UDP rows have
/// no state and the pid is the eighth. Endpoints use `.` as the port separator
/// (`*.22`, `fe80::1%lo0.8080`), so the port is whatever follows the LAST dot.
#[cfg(any(target_os = "macos", test))]
fn parse_netstat_anv(text: &str) -> Vec<NetworkConnection> {
    fn endpoint(raw: &str) -> (String, String) {
        match raw.rsplit_once('.') {
            Some((addr, port)) => (addr.to_string(), port.to_string()),
            None => (raw.to_string(), String::new()),
        }
    }
    text.lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split_whitespace().collect();
            let proto = f.first()?;
            let (protocol, tcp) = if proto.starts_with("tcp") {
                ("TCP", true)
            } else if proto.starts_with("udp") {
                ("UDP", false)
            } else {
                return None;
            };
            if f.len() < if tcp { 9 } else { 8 } {
                return None;
            }
            let (local_address, local_port) = endpoint(f[3]);
            let (remote_address, remote_port) = endpoint(f[4]);
            let (state, pid_field) = if tcp {
                (f[5].to_string(), f[8])
            } else {
                ("UNCONN".to_string(), f[7])
            };
            let pid = pid_field.parse::<u32>().ok().filter(|&p| p > 0);
            Some(NetworkConnection {
                protocol: protocol.to_string(),
                state,
                local_address,
                local_port,
                remote_address,
                remote_port,
                pid,
                process: None,
            })
        })
        .collect()
}

/// The short process name for `pid` (`proc_name`), for the connection table.
#[cfg(target_os = "macos")]
fn macos_process_name(pid: u32) -> Option<String> {
    let mut buf = [0u8; 256];
    // SAFETY: `proc_name` writes at most `buffersize` bytes into `buf` and
    // returns the length written (0 on failure).
    let len = unsafe {
        libc::proc_name(
            pid as libc::c_int,
            buf.as_mut_ptr() as *mut libc::c_void,
            buf.len() as u32,
        )
    };
    if len <= 0 {
        return None;
    }
    let end = (len as usize).min(buf.len());
    let end = buf[..end].iter().position(|&b| b == 0).unwrap_or(end);
    Some(String::from_utf8_lossy(&buf[..end]).into_owned())
}

#[cfg(target_os = "macos")]
fn macos_connections() -> Vec<NetworkConnection> {
    let mut out = Vec::new();
    for proto in ["tcp", "udp"] {
        let Ok(o) = crate::paths::command_no_window("netstat")
            .args(["-anv", "-p", proto])
            .env("LC_ALL", "C")
            .output()
        else {
            continue;
        };
        if o.status.success() {
            out.extend(parse_netstat_anv(&String::from_utf8_lossy(&o.stdout)));
        }
    }
    let mut names: std::collections::HashMap<u32, Option<String>> = std::collections::HashMap::new();
    for conn in &mut out {
        if let Some(pid) = conn.pid {
            conn.process = names
                .entry(pid)
                .or_insert_with(|| macos_process_name(pid))
                .clone();
        }
    }
    out
}

/// Local interface counters via `netstat -ibn` (spawned, not the raw
/// `NET_RT_IFLIST2` sysctl — hand-declared route-message layouts are silent-
/// garbage risk on a compile-blind port; the netstat text format is stable and
/// fixture-tested). Connection details via `netstat -anv`
/// ([`macos_connections`]).
#[cfg(target_os = "macos")]
fn local_snapshot(include_connections: bool) -> NetworkHostSnapshot {
    let output = match crate::paths::command_no_window("netstat")
        .args(["-ibn"])
        .env("LC_ALL", "C")
        .output()
    {
        Ok(out) if out.status.success() => out,
        _ => {
            return unsupported_host(
                false,
                true,
                "Local host".to_string(),
                "`netstat -ibn` could not enumerate network interfaces.",
            );
        }
    };
    let interfaces = parse_netstat_ibn(&String::from_utf8_lossy(&output.stdout));
    if interfaces.is_empty() {
        return unsupported_host(
            false,
            true,
            "Local host".to_string(),
            "No network interfaces could be enumerated.",
        );
    }
    NetworkHostSnapshot {
        supported: true,
        remote: false,
        connected: true,
        sampled_at_ms: now_ms(),
        host_label: "Local host".to_string(),
        interfaces,
        connections: include_connections.then(macos_connections),
        warning: None,
    }
}

#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
fn local_snapshot(_include_connections: bool) -> NetworkHostSnapshot {
    unsupported_host(
        false,
        true,
        "Local host".to_string(),
        "Network monitoring is not supported on this platform yet.",
    )
}

#[tauri::command]
pub async fn network_host_snapshot(
    pool: State<'_, RemotePoolState>,
    project_id: String,
    include_connections: bool,
) -> Result<NetworkHostSnapshot, String> {
    let Some(target) = remote::remote_target_for(&project_id) else {
        return Ok(local_snapshot(include_connections));
    };
    let host_label = target.spec.host.clone();
    if !remote::is_connected(pool.inner(), &project_id).await {
        return Ok(unsupported_host(
            true,
            false,
            host_label,
            "Connect the SSH project to observe its remote host.",
        ));
    }
    let spec = target.spec;
    let command = if include_connections {
        REMOTE_WITH_CONNECTIONS
    } else {
        REMOTE_IFACES
    };
    let output = tokio::task::spawn_blocking(move || {
        crate::services::ssh_exec::run_remote_shell(&spec, command)
    })
    .await
    .map_err(|e| format!("network snapshot task failed: {e}"))??;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Ok(unsupported_host(
            true,
            true,
            host_label,
            if stderr.is_empty() {
                "The SSH host does not support the Linux network collector."
            } else {
                &stderr
            },
        ));
    }
    Ok(parse_remote_snapshot(
        &String::from_utf8_lossy(&output.stdout),
        host_label,
        include_connections,
    ))
}

#[cfg(any(target_os = "linux", target_os = "macos", test))]
fn parse_master_pid(text: &str) -> Option<u32> {
    let start = text.find("pid=")?;
    text[start + 4..]
        .split(|c: char| !c.is_ascii_digit())
        .next()?
        .parse()
        .ok()
}

/// One shared system-wide `ss -H -t -i -n -p` reading, run **at most once**
/// however many projects are sampled against it. The output is system-wide —
/// the per-project part of a link snapshot is only slicing out that master's
/// row — yet `local_ssh_link` used to spawn it per call, and `-p` makes each
/// run walk every `/proc/<pid>/fd` on the machine to resolve sockets to their
/// processes. The run is lazy, so a caller whose master turns out to be gone
/// never pays for it; the inner `None` means `ss` itself failed to spawn.
#[cfg(target_os = "linux")]
#[derive(Default)]
pub(crate) struct SsDump(Option<Option<String>>);

/// macOS has no system-wide scan to share: `nettop` is asked per master pid,
/// so the shared handle carries nothing and exists only so
/// `services::net_usage` drives both platforms through one loop.
#[cfg(target_os = "macos")]
#[derive(Default)]
pub(crate) struct SsDump;

#[cfg(target_os = "linux")]
impl SsDump {
    fn text(&mut self) -> Option<&str> {
        self.0
            .get_or_insert_with(|| {
                Command::new("ss")
                    .args(["-H", "-t", "-i", "-n", "-p"])
                    .env("LC_ALL", "C")
                    .output()
                    .ok()
                    .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            })
            .as_deref()
    }
}

// `SsDump` is a unit struct on macOS only; `SsDump::default()` is the one
// spelling both platforms compile, so clippy's "drop the `default()`" would
// break Linux.
#[cfg(any(target_os = "linux", target_os = "macos"))]
#[cfg_attr(target_os = "macos", allow(clippy::default_constructed_unit_structs))]
pub(crate) fn local_ssh_link(project_id: &str) -> SshLinkSnapshot {
    local_ssh_link_shared(project_id, &mut SsDump::default())
}

/// Look the project's ControlMaster up (`ssh -O check`) and return its pid, or
/// the snapshot that explains why there is none. Shared by the Linux and macOS
/// arms — only the byte-counter source below differs.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn ssh_master_pid(project_id: &str) -> Result<u32, Box<SshLinkSnapshot>> {
    let Some(target) = remote::remote_target_for(project_id) else {
        return Err(Box::new(SshLinkSnapshot {
            supported: false,
            connected: false,
            sampled_at_ms: now_ms(),
            connection_id: None,
            rx_bytes: 0,
            tx_bytes: 0,
            local_endpoint: None,
            remote_endpoint: None,
            warning: Some("SSH-link traffic is only available for remote projects.".to_string()),
        }));
    };
    let check =
        match crate::services::ssh_exec::ssh_control_check_args(&target.spec).and_then(|args| {
            crate::paths::command_no_window("ssh")
                .args(args)
                .output()
                .map_err(|e| format!("failed to inspect SSH ControlMaster: {e}"))
        }) {
            Ok(v) => v,
            Err(e) => {
                return Err(Box::new(SshLinkSnapshot {
                    supported: true,
                    connected: false,
                    sampled_at_ms: now_ms(),
                    connection_id: None,
                    rx_bytes: 0,
                    tx_bytes: 0,
                    local_endpoint: None,
                    remote_endpoint: None,
                    warning: Some(e),
                }));
            }
        };
    let check_text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&check.stdout),
        String::from_utf8_lossy(&check.stderr)
    );
    parse_master_pid(&check_text).ok_or_else(|| Box::new(SshLinkSnapshot {
        supported: true,
        connected: false,
        sampled_at_ms: now_ms(),
        connection_id: None,
        rx_bytes: 0,
        tx_bytes: 0,
        local_endpoint: None,
        remote_endpoint: None,
        warning: Some("The shared SSH transport is not connected.".to_string()),
    }))
}

/// macOS: the master's cumulative socket counters from `nettop`, which reports
/// per-process and per-connection byte totals from the kernel's own network
/// statistics (no root needed). One `nettop -x -L 1 -p <pid>` sample lists the
/// process row and its connection rows; the connection row supplies the
/// endpoints, the totals come from whichever row is present.
#[cfg(target_os = "macos")]
pub(crate) fn local_ssh_link_shared(project_id: &str, _scan: &mut SsDump) -> SshLinkSnapshot {
    let master_pid = match ssh_master_pid(project_id) {
        Ok(pid) => pid,
        Err(snap) => return *snap,
    };
    let output = crate::paths::command_no_window("nettop")
        .args(["-x", "-L", "1", "-p", &master_pid.to_string(), "-J", "bytes_in,bytes_out"])
        .env("LC_ALL", "C")
        .output();
    let text = match output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).into_owned(),
        _ => {
            return SshLinkSnapshot {
                supported: false,
                connected: true,
                sampled_at_ms: now_ms(),
                connection_id: Some(master_pid.to_string()),
                rx_bytes: 0,
                tx_bytes: 0,
                local_endpoint: None,
                remote_endpoint: None,
                warning: Some(
                    "`nettop` is unavailable; SSH-link byte counters cannot be read.".to_string(),
                ),
            };
        }
    };
    parse_ssh_link_nettop(&text, master_pid).unwrap_or_else(|| SshLinkSnapshot {
        supported: true,
        connected: true,
        sampled_at_ms: now_ms(),
        connection_id: Some(master_pid.to_string()),
        rx_bytes: 0,
        tx_bytes: 0,
        local_endpoint: None,
        remote_endpoint: None,
        warning: Some(
            "The SSH socket is connected, but its byte counters are not visible.".to_string(),
        ),
    })
}

/// The shared-`ss` core of [`local_ssh_link`]: the per-project `ssh -O check`
/// (the master lookup) stays per call, the system-wide socket scan comes from
/// `ss` — which `services::net_usage` fills once per sample tick for all of a
/// tick's connected projects instead of once per project.
#[cfg(target_os = "linux")]
pub(crate) fn local_ssh_link_shared(project_id: &str, ss: &mut SsDump) -> SshLinkSnapshot {
    let master_pid = match ssh_master_pid(project_id) {
        Ok(pid) => pid,
        Err(snap) => return *snap,
    };
    let Some(ss_text) = ss.text() else {
        return SshLinkSnapshot {
            supported: false,
            connected: true,
            sampled_at_ms: now_ms(),
            connection_id: Some(master_pid.to_string()),
            rx_bytes: 0,
            tx_bytes: 0,
            local_endpoint: None,
            remote_endpoint: None,
            warning: Some(
                "`ss` is unavailable; SSH-link byte counters cannot be read.".to_string(),
            ),
        };
    };
    let parsed = parse_ssh_link_ss(ss_text, master_pid);
    parsed.unwrap_or_else(|| SshLinkSnapshot {
        supported: true,
        connected: true,
        sampled_at_ms: now_ms(),
        connection_id: Some(master_pid.to_string()),
        rx_bytes: 0,
        tx_bytes: 0,
        local_endpoint: None,
        remote_endpoint: None,
        warning: Some(
            "The SSH socket is connected, but its byte counters are not visible.".to_string(),
        ),
    })
}

/// Windows: nothing to measure. Windows OpenSSH does not implement
/// ControlMaster, so a remote project's channels each ride their own `ssh`
/// process rather than one shared socket, and the per-connection byte counters
/// the Linux/macOS arms read are only enabled for elevated processes there
/// (`TCP_ESTATS`). Reported as unsupported with the reason, never as zero
/// traffic.
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn local_ssh_link(_project_id: &str) -> SshLinkSnapshot {
    SshLinkSnapshot {
        supported: false,
        connected: false,
        sampled_at_ms: now_ms(),
        connection_id: None,
        rx_bytes: 0,
        tx_bytes: 0,
        local_endpoint: None,
        remote_endpoint: None,
        warning: Some(
            "SSH-link byte counters are not readable on Windows: its OpenSSH has no shared \
             ControlMaster socket, and per-connection TCP statistics need elevation."
                .to_string(),
        ),
    }
}

/// Parse one `nettop -x -L 1 -p <pid> -J bytes_in,bytes_out` sample. CSV with
/// a header naming the columns; the process row is `<name>.<pid>` and each of
/// its connections follows as `tcp4 <local><-><remote>`. The connection row is
/// preferred (it names the endpoints and is the one socket the master owns);
/// the process row is the fallback when nettop lists none.
#[cfg(any(target_os = "macos", test))]
fn parse_ssh_link_nettop(text: &str, master_pid: u32) -> Option<SshLinkSnapshot> {
    let mut lines = text.lines().filter(|l| !l.trim().is_empty());
    let header: Vec<&str> = lines.next()?.split(',').map(str::trim).collect();
    let col = |name: &str| header.iter().position(|h| *h == name);
    let (in_col, out_col) = (col("bytes_in")?, col("bytes_out")?);
    // The name column is the unnamed one (the first column is `time`).
    let name_col = header.iter().position(|h| h.is_empty()).unwrap_or(1);
    let suffix = format!(".{master_pid}");
    let mut process_row: Option<(u64, u64)> = None;
    let mut in_master = false;
    for line in lines {
        let f: Vec<&str> = line.split(',').map(str::trim).collect();
        let name = f.get(name_col).copied().unwrap_or("");
        let counters = || -> Option<(u64, u64)> {
            Some((
                f.get(in_col)?.parse::<u64>().ok()?,
                f.get(out_col)?.parse::<u64>().ok()?,
            ))
        };
        if name.ends_with(&suffix) && !name.contains("<->") {
            in_master = true;
            process_row = counters();
            continue;
        }
        if in_master && name.contains("<->") {
            let (rx_bytes, tx_bytes) = counters()?;
            let spec = name.split_whitespace().last().unwrap_or(name);
            let (local, remote) = spec.split_once("<->").unwrap_or((spec, ""));
            return Some(SshLinkSnapshot {
                supported: true,
                connected: true,
                sampled_at_ms: now_ms(),
                connection_id: Some(format!("{master_pid}:{local}:{remote}")),
                rx_bytes,
                tx_bytes,
                local_endpoint: Some(local.to_string()),
                remote_endpoint: Some(remote.to_string()),
                warning: None,
            });
        }
        if in_master && !name.is_empty() {
            // Another process's rows begin.
            in_master = false;
        }
    }
    let (rx_bytes, tx_bytes) = process_row?;
    Some(SshLinkSnapshot {
        supported: true,
        connected: true,
        sampled_at_ms: now_ms(),
        connection_id: Some(master_pid.to_string()),
        rx_bytes,
        tx_bytes,
        local_endpoint: None,
        remote_endpoint: None,
        warning: None,
    })
}

#[cfg(any(target_os = "linux", test))]
fn counter(text: &str, key: &str) -> Option<u64> {
    let start = text.find(key)?;
    text[start + key.len()..]
        .split(|c: char| !c.is_ascii_digit())
        .next()?
        .parse()
        .ok()
}

#[cfg(any(target_os = "linux", test))]
fn parse_ssh_link_ss(text: &str, master_pid: u32) -> Option<SshLinkSnapshot> {
    let needle = format!("pid={master_pid},");
    let lines: Vec<&str> = text.lines().collect();
    for (index, line) in lines.iter().enumerate() {
        if !line.contains(&needle) {
            continue;
        }
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 5 {
            continue;
        }
        let info = lines.get(index + 1).copied().unwrap_or_default();
        let tx_bytes = counter(info, "bytes_sent:")?;
        let rx_bytes = counter(info, "bytes_received:")?;
        return Some(SshLinkSnapshot {
            supported: true,
            connected: true,
            sampled_at_ms: now_ms(),
            connection_id: Some(format!("{master_pid}:{}:{}", fields[3], fields[4])),
            rx_bytes,
            tx_bytes,
            local_endpoint: Some(fields[3].to_string()),
            remote_endpoint: Some(fields[4].to_string()),
            warning: None,
        });
    }
    None
}

#[tauri::command]
pub async fn network_ssh_link_snapshot(
    pool: State<'_, RemotePoolState>,
    project_id: String,
) -> Result<SshLinkSnapshot, String> {
    if remote::remote_target_for(&project_id).is_none() {
        return Ok(local_ssh_link(&project_id));
    }
    if !remote::is_connected(pool.inner(), &project_id).await {
        return Ok(SshLinkSnapshot {
            supported: cfg!(any(target_os = "linux", target_os = "macos")),
            connected: false,
            sampled_at_ms: now_ms(),
            connection_id: None,
            rx_bytes: 0,
            tx_bytes: 0,
            local_endpoint: None,
            remote_endpoint: None,
            warning: Some("Connect the SSH project to observe its link.".to_string()),
        });
    }
    tokio::task::spawn_blocking(move || local_ssh_link(&project_id))
        .await
        .map_err(|e| format!("SSH-link snapshot task failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_proc_interfaces() {
        let input = "Inter-| Receive | Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n  lo: 100 1 0 0 0 0 0 0 200 2 0 0 0 0 0 0\neth0: 1234 2 0 0 0 0 0 0 5678 4 0 0 0 0 0 0\n";
        let parsed = parse_interfaces(input);
        assert_eq!(parsed.len(), 2);
        assert!(parsed[0].loopback);
        assert_eq!(parsed[1].name, "eth0");
        assert_eq!(parsed[1].rx_bytes, 1234);
        assert_eq!(parsed[1].tx_bytes, 5678);
    }

    #[test]
    fn parses_ipv4_ipv6_and_optional_processes() {
        let input = "tcp ESTAB 0 0 127.0.0.1:51000 10.0.0.2:22 users:((\"ssh\",pid=42,fd=3))\nudp UNCONN 0 0 [::]:5353 [::]:*\n";
        let parsed = parse_connections(input);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].process.as_deref(), Some("ssh"));
        assert_eq!(parsed[0].pid, Some(42));
        assert_eq!(parsed[1].local_address, "::");
        assert_eq!(parsed[1].remote_port, "*");
    }

    #[test]
    fn parses_netstat_anv_tcp_and_udp_rows() {
        let input = "Active Internet connections (including servers)\n\
Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)      rhiwat  shiwat    pid   epid  state    options\n\
tcp4       0      0  198.51.100.5.52000     203.0.113.4.22         ESTABLISHED  131072  131072    842      0 0x0102 0x00000020\n\
tcp6       0      0  ::1.8080               *.*                    LISTEN       131072  131072   1234      0 0x0000 0x00000106\n\
udp4       0      0  *.5353                 *.*                                 196724    9216    311      0 0x0000 0x00000000\n";
        let parsed = parse_netstat_anv(input);
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0].protocol, "TCP");
        assert_eq!(parsed[0].state, "ESTABLISHED");
        assert_eq!(parsed[0].local_address, "198.51.100.5");
        assert_eq!(parsed[0].local_port, "52000");
        assert_eq!(parsed[0].remote_address, "203.0.113.4");
        assert_eq!(parsed[0].remote_port, "22");
        assert_eq!(parsed[0].pid, Some(842));
        assert_eq!(parsed[1].local_address, "::1");
        assert_eq!(parsed[1].local_port, "8080");
        assert_eq!(parsed[1].remote_port, "*");
        assert_eq!(parsed[2].protocol, "UDP");
        assert_eq!(parsed[2].state, "UNCONN");
        assert_eq!(parsed[2].local_port, "5353");
        assert_eq!(parsed[2].pid, Some(311));
    }

    #[test]
    fn parses_nettop_master_connection_row() {
        let input = "time,,bytes_in,bytes_out,\n\
10:31:04.123456,ssh.842,120000,45000,\n\
10:31:04.123456,tcp4 198.51.100.5:52000<->203.0.113.4:22,120000,45000,\n\
10:31:04.123456,Safari.900,1,2,\n\
10:31:04.123456,tcp4 198.51.100.5:53000<->192.0.2.9:443,1,2,\n";
        let snap = parse_ssh_link_nettop(input, 842).expect("master row found");
        assert_eq!(snap.rx_bytes, 120_000);
        assert_eq!(snap.tx_bytes, 45_000);
        assert_eq!(snap.local_endpoint.as_deref(), Some("198.51.100.5:52000"));
        assert_eq!(snap.remote_endpoint.as_deref(), Some("203.0.113.4:22"));
        assert_eq!(snap.connection_id.as_deref(), Some("842:198.51.100.5:52000:203.0.113.4:22"));
        // Process row only (nettop listed no connection): totals without endpoints.
        let only = "time,,bytes_in,bytes_out,\n10:31:04.1,ssh.842,7,9,\n";
        let snap = parse_ssh_link_nettop(only, 842).unwrap();
        assert_eq!((snap.rx_bytes, snap.tx_bytes), (7, 9));
        assert_eq!(snap.local_endpoint, None);
        // Another master's rows never answer for this pid.
        assert!(parse_ssh_link_nettop(input, 999).is_none());
    }

    #[test]
    fn windows_tcp_states_and_ports_read_like_ss() {
        assert_eq!(tcp_state_name(5), "ESTAB");
        assert_eq!(tcp_state_name(2), "LISTEN");
        assert_eq!(tcp_state_name(99), "UNKNOWN");
        // 0x1600 in the low 16 bits, network order → 22.
        assert_eq!(mib_port(0x0000_1600), "22");
        assert_eq!(mib_port(0xDEAD_1600), "22");
    }

    #[test]
    fn parses_netstat_ibn_link_rows() {
        // Real `netstat -ibn` shape: header, a Link row WITHOUT an Address
        // cell (lo0), per-address rows that repeat counters (must be skipped),
        // and a Link row WITH a MAC address (en0).
        let input = "\
Name  Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
lo0   16384 <Link#1>                         354628     0   82789666   354628     0   82789666     0
lo0   16384 127           127.0.0.1          354628     -   82789666   354628     -   82789666     -
lo0   16384 ::1/128     ::1                  354628     -   82789666   354628     -   82789666     -
en0   1500  <Link#4>    a4:83:e7:00:11:22  1755892     0 1863340029  1084887     0  212930751     0
en0   1500  192.168.1     192.168.1.23       1755892     - 1863340029  1084887     -  212930751     -
utun0 1380  <Link#16>                            123     0      45678      321     0      98765     0
";
        let parsed = parse_netstat_ibn(input);
        assert_eq!(parsed.len(), 3, "only <Link#N> rows are interface totals");
        assert_eq!(parsed[0].name, "lo0");
        assert!(parsed[0].loopback);
        assert_eq!(parsed[0].rx_bytes, 82_789_666);
        assert_eq!(parsed[0].tx_bytes, 82_789_666);
        assert_eq!(parsed[1].name, "en0");
        assert!(!parsed[1].loopback);
        assert_eq!(parsed[1].rx_bytes, 1_863_340_029);
        assert_eq!(parsed[1].tx_bytes, 212_930_751);
        assert_eq!(parsed[2].name, "utun0");
        assert_eq!(parsed[2].rx_bytes, 45_678);
        assert_eq!(parsed[2].tx_bytes, 98_765);
        assert!(parsed.iter().all(|i| i.up));
        // Garbage/empty input degrades to no interfaces, not a panic.
        assert!(parse_netstat_ibn("").is_empty());
        assert!(parse_netstat_ibn("Name Mtu\nen0 1500 broken").is_empty());
    }

    #[test]
    fn utf16_alias_decoding_stops_at_nul() {
        let mut alias = [0u16; 8];
        for (i, u) in "Ethernet".encode_utf16().take(6).enumerate() {
            alias[i] = u;
        }
        alias[6] = 0;
        alias[7] = b'x' as u16; // garbage after the NUL must be ignored
        assert_eq!(utf16_nul_to_string(&alias), "Ethern");
        // No NUL at all → whole buffer.
        let full: Vec<u16> = "lo".encode_utf16().collect();
        assert_eq!(utf16_nul_to_string(&full), "lo");
        assert_eq!(utf16_nul_to_string(&[]), "");
    }

    #[test]
    fn parses_control_master_pid() {
        assert_eq!(parse_master_pid("Master running (pid=8123)"), Some(8123));
        assert_eq!(parse_master_pid("Control socket connect failed"), None);
    }

    #[test]
    fn parses_ssh_transport_counters() {
        let input = "ESTAB 0 0 192.0.2.2:40000 198.51.100.4:22 users:((\"ssh\",pid=8123,fd=3))\n\t cubic wscale:7,7 bytes_sent:4567 bytes_received:8910 segs_out:2\n";
        let parsed = parse_ssh_link_ss(input, 8123).unwrap();
        assert_eq!(parsed.tx_bytes, 4567);
        assert_eq!(parsed.rx_bytes, 8910);
        assert_eq!(parsed.remote_endpoint.as_deref(), Some("198.51.100.4:22"));
    }

    #[test]
    fn remote_snapshot_without_ss_keeps_interface_data() {
        let output = concat!("__", crate::app_upper!(), "_IFACES__\neth0: 12 0 0 0 0 0 0 0 34 0 0 0 0 0 0 0\n__", crate::app_upper!(), "_STATES__\neth0 up\n__", crate::app_upper!(), "_CONNECTIONS__\n__", crate::app_upper!(), "_NO_SS__\n");
        let parsed = parse_remote_snapshot(output, "host".to_string(), true);
        assert!(parsed.supported);
        assert!(parsed.interfaces[0].up);
        assert!(parsed.connections.is_none());
        assert!(parsed.warning.is_some());
    }
}

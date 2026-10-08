use std::path::Path;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, State};

use crate::commands::apps::{opened_windows_for_project, TrackedWindow, WindowRegistryState};
use crate::platform::{detect_backend, WorkspaceBackend, WorkspaceInfo};
use crate::services::window_service;

pub struct WorkspaceState {
    pub backend: Box<dyn WorkspaceBackend>,
}

pub type WorkspaceStateArc = Arc<Mutex<WorkspaceState>>;

impl Default for WorkspaceState {
    fn default() -> Self {
        Self::new()
    }
}

impl WorkspaceState {
    pub fn new() -> Self {
        WorkspaceState {
            backend: detect_backend(),
        }
    }
}

#[tauri::command]
pub fn workspace_info(state: State<'_, WorkspaceStateArc>) -> WorkspaceInfo {
    state.lock().unwrap().backend.info()
}

/// What the running desktop's workspace backend can do, for Settings: which
/// backend was picked and whether a project switch really hides the previous
/// project's app windows (`WorkspaceBackend::can_park`). A separate command
/// rather than new `WorkspaceInfo` fields, so no backend constructor (macOS's
/// among them, uncompilable here) has to change.
#[derive(Debug, Clone, serde::Serialize)]
pub struct WorkspaceCapabilities {
    pub backend: String,
    pub can_park: bool,
}

pub(crate) fn capabilities_of(backend: &dyn WorkspaceBackend) -> WorkspaceCapabilities {
    WorkspaceCapabilities {
        backend: backend.name().to_string(),
        can_park: backend.can_park(),
    }
}

#[tauri::command]
pub fn workspace_capabilities(state: State<'_, WorkspaceStateArc>) -> WorkspaceCapabilities {
    capabilities_of(&*state.lock().unwrap().backend)
}

#[tauri::command]
pub fn workspace_switch(
    state: State<'_, WorkspaceStateArc>,
    windows: State<'_, WindowRegistryState>,
    app: AppHandle,
    project_id: Option<String>,
    previous_project_id: Option<String>,
) -> Result<(), String> {
    let (previous_window_ids, current_window_ids) = {
        let windows = windows.lock().unwrap();
        let previous_window_ids =
            window_service::project_window_ids(&windows.windows, previous_project_id.as_deref());
        let current_window_ids =
            window_service::project_window_ids(&windows.windows, project_id.as_deref());
        (previous_window_ids, current_window_ids)
    };

    {
        let workspace = state.lock().unwrap();
        window_service::hide_windows(&*workspace.backend, &previous_window_ids);
        window_service::show_windows(&*workspace.backend, &current_window_ids);
    }
    let info = state.lock().unwrap().backend.info();
    let _ = app.emit("workspace-changed", info);
    Ok(())
}

/// Does the desktop shell own the lone Super/Meta key?
///
/// The frontend binds the bare Super key to the panel toggle, and must not do
/// so where the shell answers that key itself (GNOME's overview, KDE's
/// launcher) — see `platform::desktop_claims_super`. Read once at startup and
/// cached in `src/lib/shortcuts/superKey.ts`; the environment cannot change under a
/// running session.
#[tauri::command]
pub fn desktop_owns_super_key() -> bool {
    crate::platform::desktop_owns_super_key()
}

#[tauri::command]
pub fn show_window(state: State<'_, WorkspaceStateArc>, window_id: u64) -> Result<(), String> {
    state.lock().unwrap().backend.show_window(window_id)
}

#[tauri::command]
pub fn hide_window(state: State<'_, WorkspaceStateArc>, window_id: u64) -> Result<(), String> {
    state.lock().unwrap().backend.hide_window(window_id)
}

#[tauri::command]
pub fn get_opened_windows(
    windows: State<'_, WindowRegistryState>,
    project_id: Option<String>,
) -> Vec<TrackedWindow> {
    let mut windows = windows.lock().unwrap();
    // Backstop for the exit watcher: a read is the moment a stale dead row
    // would become visible, so sweep the requested scope first.
    crate::commands::apps::prune_dead_windows(&mut windows, project_id.as_deref());
    opened_windows_for_project(windows.windows.values(), project_id.as_deref())
}

#[tauri::command]
pub fn switch_project_windows(
    state: State<'_, WorkspaceStateArc>,
    windows: State<'_, WindowRegistryState>,
    project_id: Option<String>,
    previous_project_id: Option<String>,
) -> Result<(), String> {
    let (previous_window_ids, current_window_ids) = {
        let windows = windows.lock().unwrap();
        let previous =
            opened_windows_for_project(windows.windows.values(), previous_project_id.as_deref());
        let current = opened_windows_for_project(windows.windows.values(), project_id.as_deref());
        (
            previous
                .into_iter()
                .filter_map(|window| window.window_id)
                .collect::<Vec<_>>(),
            current
                .into_iter()
                .filter_map(|window| window.window_id)
                .collect::<Vec<_>>(),
        )
    };

    let backend = state.lock().unwrap();
    for window_id in previous_window_ids {
        if let Err(error) = backend.backend.hide_window(window_id) {
            eprintln!("hide tracked window {window_id} failed: {error}");
        }
    }
    for window_id in current_window_ids {
        if let Err(error) = backend.backend.show_window(window_id) {
            eprintln!("show tracked window {window_id} failed: {error}");
        }
    }
    Ok(())
}

#[tauri::command]
pub fn workspace_name(state: State<'_, WorkspaceStateArc>) -> String {
    state.lock().unwrap().backend.name().to_string()
}

/// Returns "wlan", "lan", or "disconnected".
///
/// Async + `spawn_blocking`: the header polls this every 10 s, and on
/// Windows/macOS the probe spawns `netsh` / `route` + `networksetup`
/// (100–500 ms each, worse when the network stack is wedged) — run
/// synchronously that work landed on the main thread every tick. The spawns
/// are additionally time-capped ([`probe_output_capped`]) so a hung tool
/// yields "disconnected" instead of a stuck poll.
#[tauri::command]
pub async fn network_conn_type() -> String {
    tokio::task::spawn_blocking(network_conn_type_blocking)
        .await
        .unwrap_or_else(|_| "disconnected".into())
}

pub(crate) fn network_conn_type_blocking() -> String {
    if cfg!(target_os = "linux") {
        detect_conn_type_linux(Path::new("/sys/class/net"))
    } else if cfg!(target_os = "windows") {
        detect_conn_type_windows()
    } else if cfg!(target_os = "macos") {
        detect_conn_type_macos()
    } else {
        "disconnected".into()
    }
}

/// Hard cap on one connectivity-probe spawn. Well under the header's 10 s poll
/// interval so a slow tool cannot make ticks pile up.
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Run `bin args…` and return its stdout, or `None` on spawn failure or when it
/// exceeds [`PROBE_TIMEOUT`] (the child is killed). The slimmed-down twin of
/// `printing.rs`'s `run_capped`: `netsh`/`networksetup` talk to OS services
/// that can hang, and `.output()` alone would wait with them. stderr is
/// discarded (these probes only pattern-match stdout), so a single reader
/// thread suffices and cannot deadlock on a full pipe.
fn probe_output_capped(bin: &str, args: &[&str]) -> Option<String> {
    use std::process::Stdio;
    let mut child = crate::paths::command_no_window(bin)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut out_pipe = child.stdout.take();
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(p) = out_pipe.as_mut() {
            let _ = std::io::Read::read_to_end(p, &mut buf);
        }
        buf
    });
    let deadline = std::time::Instant::now() + PROBE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(40)),
            Err(_) => return None,
        }
    }
    Some(String::from_utf8_lossy(&reader.join().unwrap_or_default()).into_owned())
}

/// The name (SSID) of the wireless network in use, or an empty string when
/// there is none or nothing on the box can name it.
///
/// Separate from [`network_conn_type`] rather than folded into it because the
/// answer costs a process spawn on every platform, and only a Wi-Fi link has
/// one — the header asks for it only after the type probe says `wlan`, so an
/// Ethernet machine never pays for it. Same `spawn_blocking` + time cap as the
/// type probe, for the same reason.
#[tauri::command]
pub async fn network_wifi_ssid() -> String {
    tokio::task::spawn_blocking(wifi_ssid_blocking)
        .await
        .unwrap_or_default()
}

pub(crate) fn wifi_ssid_blocking() -> String {
    if cfg!(target_os = "linux") {
        wifi_ssid_linux(Path::new("/sys/class/net"))
    } else if cfg!(target_os = "windows") {
        ssid_memo(None, SSID_MAX_AGE_UNKEYED, wifi_ssid_windows)
    } else if cfg!(target_os = "macos") {
        ssid_memo(None, SSID_MAX_AGE_UNKEYED, wifi_ssid_macos)
    } else {
        String::new()
    }
}

/// How long a read SSID is reused while the link it was read on is unchanged.
/// The header asks every 10 s (30 s quiesced) and each answer costs one to three
/// process spawns — and `nmcli dev wifi` may also kick off a Wi-Fi scan. The
/// link key ([`wifi_ssid_linux`]) catches a reconnect at once; this only bounds
/// how long a change the key cannot see (none known) could go unnoticed.
const SSID_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(60);
/// The same where no link key exists (Windows, macOS): a switch of network shows
/// within this, not within the 10 s poll.
const SSID_MAX_AGE_UNKEYED: std::time::Duration = std::time::Duration::from_secs(30);

/// The last SSID read: the link key it was read under, when, and the answer.
type SsidMemo = Option<(Option<String>, std::time::Instant, String)>;
static SSID_MEMO: Mutex<SsidMemo> = Mutex::new(None);

/// Whether a memo taken under `memo_key` at `memo_at` still answers for `key`
/// at `now`. Pure.
fn ssid_memo_fresh(
    memo_key: &Option<String>,
    memo_at: std::time::Instant,
    key: &Option<String>,
    now: std::time::Instant,
    max_age: std::time::Duration,
) -> bool {
    memo_key == key && now.saturating_duration_since(memo_at) < max_age
}

/// The SSID from the memo when it is fresh for `key`, else from `read` (and
/// remembered — an empty answer too, so a box with none of the tools does not
/// spawn three failing probes per poll).
fn ssid_memo(key: Option<String>, max_age: std::time::Duration, read: impl FnOnce() -> String) -> String {
    let now = std::time::Instant::now();
    if let Some((memo_key, at, ssid)) = SSID_MEMO.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        if ssid_memo_fresh(memo_key, *at, &key, now, max_age) {
            return ssid.clone();
        }
    }
    let ssid = read();
    *SSID_MEMO.lock().unwrap_or_else(|e| e.into_inner()) = Some((key, now, ssid.clone()));
    ssid
}

/// What identifies one association of `iface`: its name plus the kernel's
/// `carrier_changes` counter, which moves on every link drop — and joining
/// another network drops the link first. A plain sysfs read, no spawn.
fn wireless_link_key(net_dir: &Path, iface: &str) -> String {
    let changes = std::fs::read_to_string(net_dir.join(iface).join("carrier_changes")).unwrap_or_default();
    format!("{iface}:{}", changes.trim())
}

/// The first up wireless interface, by the same walk (and the same ordering)
/// [`detect_conn_type_linux`] uses to answer "wlan" — so the SSID always
/// belongs to the link the icon is drawing.
pub(crate) fn active_wireless_iface(net_dir: &Path) -> Option<String> {
    let entries = std::fs::read_dir(net_dir).ok()?;
    let mut names: Vec<_> = entries.flatten().map(|e| e.path()).collect();
    names.sort();
    for iface in names {
        let name = iface.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name == "lo" {
            continue;
        }
        let state = std::fs::read_to_string(iface.join("operstate")).unwrap_or_default();
        if state.trim() != "up" {
            continue;
        }
        if iface.join("wireless").is_dir() {
            return Some(name.to_string());
        }
    }
    None
}

fn wifi_ssid_linux(net_dir: &Path) -> String {
    let Some(iface) = active_wireless_iface(net_dir) else {
        return String::new();
    };
    let key = wireless_link_key(net_dir, &iface);
    ssid_memo(Some(key), SSID_MAX_AGE, || probe_ssid_linux(&iface))
}

/// Ask the tools on the box for `iface`'s SSID. Spawns; see [`ssid_memo`].
fn probe_ssid_linux(iface: &str) -> String {
    // Three tools because no single one is everywhere: `iwgetid` is the cheapest
    // and needs no daemon but ships in wireless-tools, which modern desktops
    // drop; `nmcli` is on every NetworkManager box but on none without it; `iw`
    // is what a bare kernel userland always has.
    if let Some(out) = probe_output_capped("iwgetid", &[iface, "-r"]) {
        let ssid = out.trim();
        if !ssid.is_empty() {
            return ssid.to_string();
        }
    }
    // `--rescan no`: list what NetworkManager already knows. Left to `auto`,
    // `nmcli dev wifi` starts a fresh scan whenever the last one is older than
    // 30 s — on every poll, a radio scan nobody asked for.
    if let Some(out) =
        probe_output_capped("nmcli", &["-t", "-f", "active,ssid", "dev", "wifi", "list", "--rescan", "no"])
    {
        if let Some(ssid) = parse_nmcli_ssid(&out) {
            return ssid;
        }
    }
    if let Some(out) = probe_output_capped("iw", &["dev", iface, "link"]) {
        if let Some(ssid) = parse_iw_ssid(&out) {
            return ssid;
        }
    }
    String::new()
}

/// `nmcli -t` output is one `active:ssid` row per visible network; the joined
/// one is the row whose first field is `yes`. `-t` escapes a colon inside a
/// field as `\:`, so the split is on the *first* separator and the rest is
/// unescaped rather than split further.
pub(crate) fn parse_nmcli_ssid(text: &str) -> Option<String> {
    for line in text.lines() {
        let mut active = String::new();
        let mut rest = String::new();
        let mut escaped = false;
        let mut in_ssid = false;
        for ch in line.chars() {
            let target = if in_ssid { &mut rest } else { &mut active };
            if escaped {
                target.push(ch);
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == ':' && !in_ssid {
                in_ssid = true;
            } else {
                target.push(ch);
            }
        }
        if in_ssid && active.trim() == "yes" && !rest.trim().is_empty() {
            return Some(rest.trim().to_string());
        }
    }
    None
}

/// `iw dev <iface> link` prints an indented `SSID: <name>` line while
/// associated, and "Not connected." otherwise.
pub(crate) fn parse_iw_ssid(text: &str) -> Option<String> {
    for line in text.lines() {
        if let Some(rest) = line.trim().strip_prefix("SSID:") {
            let ssid = rest.trim();
            if !ssid.is_empty() {
                return Some(ssid.to_string());
            }
        }
    }
    None
}

fn wifi_ssid_windows() -> String {
    probe_output_capped("netsh", &["wlan", "show", "interfaces"])
        .and_then(|text| parse_netsh_ssid(&text))
        .unwrap_or_default()
}

/// `netsh wlan show interfaces` lists both `SSID` and `BSSID` (the access
/// point's MAC); only the first is a network name, so the prefix match is on
/// the whole key, not a substring.
pub(crate) fn parse_netsh_ssid(text: &str) -> Option<String> {
    for line in text.lines() {
        let line = line.trim();
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if key.trim().eq_ignore_ascii_case("SSID") {
            let ssid = value.trim();
            if !ssid.is_empty() {
                return Some(ssid.to_string());
            }
        }
    }
    None
}

fn wifi_ssid_macos() -> String {
    let Some(route) = probe_output_capped("route", &["-n", "get", "default"]) else {
        return String::new();
    };
    match route_get_field(&route, "interface") {
        Some(iface) => probe_output_capped("networksetup", &["-getairportnetwork", iface])
            .and_then(|text| parse_airport_ssid(&text))
            .unwrap_or_default(),
        None => String::new(),
    }
}

/// One `key: value` line of macOS `route -n get default` (`gateway`,
/// `interface`, …), trimmed; `None` when the line is missing or empty.
fn route_get_field<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    text.lines().find_map(|line| {
        let (k, v) = line.trim().split_once(':')?;
        let v = v.trim();
        (k.trim() == key && !v.is_empty()).then_some(v)
    })
}

/// `networksetup -getairportnetwork <iface>` answers
/// `Current Wi-Fi Network: <name>`, or a "not associated" sentence with no
/// colon-separated value on a link that is down.
pub(crate) fn parse_airport_ssid(text: &str) -> Option<String> {
    let line = text.lines().next()?.trim();
    let (key, value) = line.split_once(':')?;
    if !key.to_lowercase().contains("network") {
        return None;
    }
    let ssid = value.trim();
    (!ssid.is_empty()).then(|| ssid.to_string())
}

/// Which network this machine is on, in enough detail to tell two of them
/// apart — what the print manager keys a per-network default printer by.
///
/// The fields are raw readings, not a key: the frontend builds the key (and the
/// label, which it has to translate) from them, so the rule "what counts as the
/// same network" lives in one place (`lib/window/printerNetworkDefaults.ts`).
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct NetworkIdentity {
    /// `wlan` | `lan` | `disconnected`, as [`network_conn_type`] answers.
    pub kind: String,
    /// The Wi-Fi network's name. Empty on a wired link or when nothing could
    /// name it.
    pub ssid: String,
    /// The default gateway's IPv4 address, shown in the label. Only read for a
    /// wired link (Wi-Fi has its SSID): from `/proc` on Linux, `route -n get
    /// default` on macOS and `route print -4` on Windows; empty when none of
    /// them names one.
    pub gateway_ip: String,
    /// A salted SHA-256 of the gateway's hardware address (16 hex chars), never
    /// the MAC itself: it ends up as a settings key, and a settings file that is
    /// synced or shared must not carry a hardware address that locates a site.
    /// The MAC is what tells the office LAN from the home one — two routers can
    /// share an IP, not a MAC.
    pub gateway_id: String,
}

/// Async + `spawn_blocking` for [`network_conn_type`]'s reason. Called only by
/// the per-network default-printer host, and only while at least one such
/// default is saved, so a machine that never set one never pays the SSID spawn.
#[tauri::command]
pub async fn network_identity() -> NetworkIdentity {
    tokio::task::spawn_blocking(network_identity_blocking)
        .await
        .unwrap_or_else(|_| NetworkIdentity {
            kind: "disconnected".into(),
            ..Default::default()
        })
}

fn network_identity_blocking() -> NetworkIdentity {
    let kind = network_conn_type_blocking();
    let mut id = NetworkIdentity {
        kind: kind.clone(),
        ..Default::default()
    };
    match kind.as_str() {
        "wlan" => id.ssid = wifi_ssid_blocking(),
        "lan" => {
            if let Some((ip, mac)) = wired_gateway() {
                id.gateway_id = mac.map(|mac| gateway_id_of(&mac)).unwrap_or_default();
                id.gateway_ip = ip;
            }
        }
        _ => {}
    }
    id
}

/// The wired link's default gateway and, when the neighbour table has it
/// resolved, its MAC. Linux reads `/proc` (no spawn); macOS and Windows ask
/// `route` and `arp`, each spawn capped like the other probes.
fn wired_gateway() -> Option<(String, Option<String>)> {
    if cfg!(target_os = "linux") {
        let route = std::fs::read_to_string("/proc/net/route").unwrap_or_default();
        let ip = parse_proc_default_gateway(&route)?;
        let arp = std::fs::read_to_string("/proc/net/arp").unwrap_or_default();
        let mac = parse_proc_arp_mac(&arp, &ip);
        Some((ip, mac))
    } else if cfg!(target_os = "macos") {
        let ip = gateway_from_route_get(&probe_output_capped("route", &["-n", "get", "default"])?)?;
        let mac = probe_output_capped("arp", &["-n", &ip]).and_then(|text| mac_from_arp_n(&text, &ip));
        Some((ip, mac))
    } else if cfg!(target_os = "windows") {
        let ip = gateway_from_route_print(&probe_output_capped("route", &["print", "-4"])?)?;
        let mac = probe_output_capped("arp", &["-a", &ip]).and_then(|text| mac_from_arp_a(&text, &ip));
        Some((ip, mac))
    } else {
        None
    }
}

/// The IPv4 gateway of macOS `route -n get default` (its `gateway:` line). A
/// default route through an interface (`link#5`) names no gateway.
pub(crate) fn gateway_from_route_get(text: &str) -> Option<String> {
    let gw = route_get_field(text, "gateway")?;
    gw.parse::<std::net::Ipv4Addr>().ok().map(|ip| ip.to_string())
}

/// The IPv4 default gateway of Windows `route print -4`: the lowest-metric
/// `0.0.0.0 0.0.0.0 <gateway> <interface> <metric>` row of the active table.
/// The column headings are localised, the rows are not, so only rows are read;
/// an `On-link` gateway and the persistent table's `Default` metric are skipped.
pub(crate) fn gateway_from_route_print(text: &str) -> Option<String> {
    let mut best: Option<(u32, String)> = None;
    for line in text.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        let [dest, mask, gw, _iface, metric] = cols.as_slice() else {
            continue;
        };
        if *dest != "0.0.0.0" || *mask != "0.0.0.0" {
            continue;
        }
        let (Ok(ip), Ok(metric)) = (gw.parse::<std::net::Ipv4Addr>(), metric.parse::<u32>()) else {
            continue;
        };
        if ip.is_unspecified() {
            continue;
        }
        if best.as_ref().is_none_or(|(m, _)| metric < *m) {
            best = Some((metric, ip.to_string()));
        }
    }
    best.map(|(_, ip)| ip)
}

/// `ip`'s MAC from macOS `arp -n <ip>`: `? (<ip>) at <mac> on en0 …`. An
/// `(incomplete)` entry or `-- no entry` is no answer.
pub(crate) fn mac_from_arp_n(text: &str, ip: &str) -> Option<String> {
    let wanted = format!("({ip})");
    text.lines().find_map(|line| {
        let mut words = line.split_whitespace();
        words.find(|w| *w == wanted)?;
        (words.next()? == "at").then_some(())?;
        canonical_mac(words.next()?)
    })
}

/// `ip`'s MAC from Windows `arp -a [<ip>]`: rows `<ip> <aa-bb-cc-dd-ee-ff>
/// <type>` under each `Interface:` heading (headings localised, rows not).
pub(crate) fn mac_from_arp_a(text: &str, ip: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let cols: Vec<&str> = line.split_whitespace().collect();
        match cols.as_slice() {
            [addr, mac, _kind] if *addr == ip => canonical_mac(mac),
            _ => None,
        }
    })
}

/// A MAC as `/proc/net/arp` spells it — six two-digit lower-case hex groups
/// joined by `:` — from macOS's unpadded `0:1a:2b:3:4:5` or Windows'
/// `00-1A-2B-03-04-05`, so a network's id is the same whichever OS read it.
/// The all-zero and broadcast addresses are no answer.
fn canonical_mac(raw: &str) -> Option<String> {
    let groups: Vec<&str> = raw.split([':', '-']).collect();
    if groups.len() != 6 {
        return None;
    }
    let mut bytes = [0u8; 6];
    for (b, g) in bytes.iter_mut().zip(&groups) {
        if g.is_empty() || g.len() > 2 {
            return None;
        }
        *b = u8::from_str_radix(g, 16).ok()?;
    }
    if bytes == [0; 6] || bytes == [0xff; 6] {
        return None;
    }
    Some(bytes.iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(":"))
}

/// The IPv4 default gateway from `/proc/net/route`: the lowest-metric row whose
/// destination is `0.0.0.0` and which carries `RTF_GATEWAY`. The kernel prints
/// the address as the native-endian integer of network-order bytes, so
/// `to_ne_bytes` recovers the octets on either endianness.
pub(crate) fn parse_proc_default_gateway(text: &str) -> Option<String> {
    const RTF_UP: u32 = 0x1;
    const RTF_GATEWAY: u32 = 0x2;
    let mut best: Option<(u32, String)> = None;
    for line in text.lines().skip(1) {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 7 || cols[1] != "00000000" {
            continue;
        }
        let Ok(flags) = u32::from_str_radix(cols[3], 16) else {
            continue;
        };
        if flags & (RTF_UP | RTF_GATEWAY) != RTF_UP | RTF_GATEWAY {
            continue;
        }
        let (Ok(gw), Ok(metric)) = (u32::from_str_radix(cols[2], 16), cols[6].parse::<u32>()) else {
            continue;
        };
        if gw == 0 {
            continue;
        }
        let ip = std::net::Ipv4Addr::from(gw.to_ne_bytes()).to_string();
        if best.as_ref().is_none_or(|(m, _)| metric < *m) {
            best = Some((metric, ip));
        }
    }
    best.map(|(_, ip)| ip)
}

/// The opaque id [`NetworkIdentity::gateway_id`] carries for a MAC.
///
/// The hash's context string is pinned to the one the app had when these ids
/// were first stored (`PINNED_…`): it is an input of every remembered
/// network's id, so a context that followed a rename would forget them all.
/// It is never shown or written anywhere.
pub(crate) fn gateway_id_of(mac: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(format!("{}{}", crate::brand::PINNED_GATEWAY_ID_CONTEXT, mac.to_ascii_lowercase()));
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// `ip`'s hardware address from `/proc/net/arp`, lower-cased. An incomplete
/// entry (flags without `ATF_COM`) or the all-zero address is no answer — a
/// neighbour the kernel has not resolved yet does not name a network.
pub(crate) fn parse_proc_arp_mac(text: &str, ip: &str) -> Option<String> {
    const ATF_COM: u32 = 0x2;
    text.lines().skip(1).find_map(|line| {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 4 || cols[0] != ip {
            return None;
        }
        let flags = u32::from_str_radix(cols[2].trim_start_matches("0x"), 16).ok()?;
        let mac = cols[3].to_ascii_lowercase();
        (flags & ATF_COM != 0 && mac != "00:00:00:00:00:00").then_some(mac)
    })
}

pub(crate) fn detect_conn_type_linux(net_dir: &Path) -> String {
    let Ok(entries) = std::fs::read_dir(net_dir) else {
        return "disconnected".into();
    };
    let mut names: Vec<_> = entries.flatten().map(|e| e.path()).collect();
    names.sort();
    for iface in names {
        let name = iface.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name == "lo" {
            continue;
        }
        let state = std::fs::read_to_string(iface.join("operstate")).unwrap_or_default();
        if state.trim() != "up" {
            continue;
        }
        if iface.join("wireless").is_dir() {
            return "wlan".into();
        }
        return "lan".into();
    }
    "disconnected".into()
}

fn detect_conn_type_windows() -> String {
    // Check for an active Wi-Fi connection via `netsh wlan show interfaces`.
    // `command_no_window` (inside `probe_output_capped`) keeps these probes
    // from flashing a console window on every poll (Tabtivity is a windowed app
    // with no console).
    if let Some(text) = probe_output_capped("netsh", &["wlan", "show", "interfaces"]) {
        let text = text.to_lowercase();
        if text.contains("state") && text.contains("connected") {
            return "wlan".into();
        }
    }
    // Check for any active Ethernet via `netsh interface show interface`.
    if let Some(text) = probe_output_capped("netsh", &["interface", "show", "interface"]) {
        if text.to_lowercase().contains("connected") {
            return "lan".into();
        }
    }
    "disconnected".into()
}

pub(crate) fn detect_conn_type_macos() -> String {
    // Check the default route's interface, then probe its type via networksetup.
    let Some(text) = probe_output_capped("route", &["-n", "get", "default"]) else {
        return "disconnected".into();
    };
    for line in text.lines() {
        if let Some(iface) = line.trim().strip_prefix("interface:") {
            let iface = iface.trim();
            let hw = probe_output_capped("networksetup", &["-getinfo", iface])
                .map(|o| o.to_lowercase())
                .unwrap_or_default();
            if hw.contains("wi-fi") || hw.contains("airport") {
                return "wlan".into();
            }
            return "lan".into();
        }
    }
    "disconnected".into()
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn an_ssid_memo_answers_only_for_its_own_link_and_age() {
        let at = std::time::Instant::now();
        let later = |s| at + std::time::Duration::from_secs(s);
        let key = Some("wlan0:4".to_string());
        assert!(ssid_memo_fresh(&key, at, &key, later(59), SSID_MAX_AGE));
        assert!(!ssid_memo_fresh(&key, at, &key, later(60), SSID_MAX_AGE));
        // A reconnect moves the carrier counter: re-read at once.
        assert!(!ssid_memo_fresh(&key, at, &Some("wlan0:6".into()), later(1), SSID_MAX_AGE));
        assert!(!ssid_memo_fresh(&key, at, &Some("wlan1:4".into()), later(1), SSID_MAX_AGE));
        assert!(ssid_memo_fresh(&None, at, &None, later(29), SSID_MAX_AGE_UNKEYED));
    }

    #[test]
    fn the_link_key_follows_the_carrier_counter() {
        let tmp = tempfile::tempdir().unwrap();
        mk(tmp.path(), "wlan0", true, true);
        fs::write(tmp.path().join("wlan0").join("carrier_changes"), "4\n").unwrap();
        assert_eq!(wireless_link_key(tmp.path(), "wlan0"), "wlan0:4");
        fs::write(tmp.path().join("wlan0").join("carrier_changes"), "6\n").unwrap();
        assert_eq!(wireless_link_key(tmp.path(), "wlan0"), "wlan0:6");
    }

    fn mk(dir: &std::path::Path, iface: &str, up: bool, wireless: bool) {
        let iface_dir = dir.join(iface);
        fs::create_dir_all(&iface_dir).unwrap();
        fs::write(
            iface_dir.join("operstate"),
            if up { "up\n" } else { "down\n" },
        )
        .unwrap();
        if wireless {
            fs::create_dir_all(iface_dir.join("wireless")).unwrap();
        }
    }

    #[test]
    fn proc_route_picks_the_lowest_metric_default_gateway() {
        // Documentation addresses only (RFC 5737 TEST-NET-1/-2).
        let gw = |ip: [u8; 4]| format!("{:08X}", u32::from_ne_bytes(ip));
        let route = format!(
            "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\n\
             wlan0\t00000000\t{}\t0003\t0\t0\t600\t00000000\t0\t0\t0\n\
             eth0\t00000000\t{}\t0003\t0\t0\t100\t00000000\t0\t0\t0\n\
             eth0\t000200C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0\n",
            gw([198, 51, 100, 1]),
            gw([192, 0, 2, 1]),
        );
        assert_eq!(parse_proc_default_gateway(&route).as_deref(), Some("192.0.2.1"));
        // A down route (no RTF_UP) or one without RTF_GATEWAY is not a gateway.
        let down = format!(
            "hdr\neth0\t00000000\t{}\t0002\t0\t0\t100\t00000000\t0\t0\t0\n",
            gw([192, 0, 2, 1])
        );
        assert_eq!(parse_proc_default_gateway(&down), None);
        assert_eq!(parse_proc_default_gateway(""), None);
    }

    #[test]
    fn proc_arp_resolves_only_complete_entries() {
        // Documentation IPs and a locally administered (02:…) MAC.
        let arp = "IP address       HW type     Flags       HW address            Mask     Device\n\
                   192.0.2.1        0x1         0x2         02:00:00:00:00:01     *        eth0\n\
                   192.0.2.7        0x1         0x0         00:00:00:00:00:00     *        eth0\n";
        assert_eq!(
            parse_proc_arp_mac(arp, "192.0.2.1").as_deref(),
            Some("02:00:00:00:00:01")
        );
        assert_eq!(parse_proc_arp_mac(arp, "192.0.2.7"), None);
        assert_eq!(parse_proc_arp_mac(arp, "192.0.2.9"), None);
    }

    #[test]
    fn macos_route_get_names_the_gateway_and_the_interface() {
        // Captured shape of `route -n get default` (documentation address).
        let route = "   route to: default\n\
                     destination: default\n       mask: default\n    gateway: 192.0.2.1\n\
                     \x20 interface: en0\n      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING>\n\
                     \x20recvpipe  sendpipe  ssthresh  rtt,msec    rttvar  hopcount      mtu     expire\n\
                     \x20      0         0         0         0         0         0      1500         0\n";
        assert_eq!(gateway_from_route_get(route).as_deref(), Some("192.0.2.1"));
        assert_eq!(route_get_field(route, "interface"), Some("en0"));
        // A default route through an interface has no gateway address.
        let link = "destination: default\n    gateway: link#5\n  interface: utun3\n";
        assert_eq!(gateway_from_route_get(link), None);
        assert_eq!(gateway_from_route_get("route: writing to routing socket: not in table\n"), None);
    }

    #[test]
    fn macos_arp_n_resolves_only_a_complete_entry() {
        let arp = "? (192.0.2.1) at 2:0:0:0:a:1 on en0 ifscope [ethernet]\n";
        assert_eq!(mac_from_arp_n(arp, "192.0.2.1").as_deref(), Some("02:00:00:00:0a:01"));
        assert_eq!(mac_from_arp_n(arp, "192.0.2.10"), None);
        assert_eq!(mac_from_arp_n("? (192.0.2.1) at (incomplete) on en0 ifscope [ethernet]\n", "192.0.2.1"), None);
        assert_eq!(mac_from_arp_n("192.0.2.1 (192.0.2.1) -- no entry\n", "192.0.2.1"), None);
    }

    #[test]
    fn windows_route_print_picks_the_lowest_metric_default_gateway() {
        // Captured shape of `route print -4` (documentation addresses; the
        // headings are localised on a non-English Windows, the rows are not).
        let route = "===========================================================================\n\
                     Interface List\n 12...02 00 00 00 00 01 ......Ethernet Adapter\n\
                     \x20 1...........................Software Loopback Interface 1\n\
                     ===========================================================================\n\n\
                     IPv4 Route Table\n\
                     ===========================================================================\n\
                     Active Routes:\n\
                     Network Destination        Netmask          Gateway       Interface  Metric\n\
                     \x20         0.0.0.0          0.0.0.0     198.51.100.1  198.51.100.20     50\n\
                     \x20         0.0.0.0          0.0.0.0        192.0.2.1     192.0.2.20     25\n\
                     \x20         0.0.0.0          0.0.0.0         On-link     192.0.2.20    281\n\
                     ===========================================================================\n\
                     Persistent Routes:\n\
                     \x20 Network Address          Netmask  Gateway Address  Metric\n\
                     \x20         0.0.0.0          0.0.0.0      203.0.113.1  Default\n\
                     ===========================================================================\n";
        assert_eq!(gateway_from_route_print(route).as_deref(), Some("192.0.2.1"));
        let on_link = "          0.0.0.0          0.0.0.0         On-link     192.0.2.20     25\n";
        assert_eq!(gateway_from_route_print(on_link), None);
        assert_eq!(gateway_from_route_print(""), None);
    }

    #[test]
    fn windows_arp_a_resolves_the_gateway_row() {
        let arp = "\nInterface: 192.0.2.20 --- 0xc\n\
                   \x20 Internet Address      Physical Address      Type\n\
                   \x20 192.0.2.1             02-00-00-00-0A-01     dynamic\n\
                   \x20 192.0.2.7             00-00-00-00-00-00     invalid\n\
                   \x20 192.0.2.255           ff-ff-ff-ff-ff-ff     static\n";
        assert_eq!(mac_from_arp_a(arp, "192.0.2.1").as_deref(), Some("02:00:00:00:0a:01"));
        assert_eq!(mac_from_arp_a(arp, "192.0.2.7"), None);
        assert_eq!(mac_from_arp_a(arp, "192.0.2.255"), None);
        assert_eq!(mac_from_arp_a("No ARP Entries Found.\n", "192.0.2.1"), None);
        // The interface heading's own address is not a row.
        assert_eq!(mac_from_arp_a(arp, "192.0.2.20"), None);
    }

    #[test]
    fn every_os_spells_one_mac_the_same() {
        // The id the network is remembered under must not depend on which OS
        // read the neighbour table.
        let linux = parse_proc_arp_mac(
            "hdr\n 192.0.2.1 0x1 0x2 02:00:00:00:0a:01 * eth0\n",
            "192.0.2.1",
        );
        assert_eq!(linux.as_deref(), Some("02:00:00:00:0a:01"));
        assert_eq!(canonical_mac("2:0:0:0:a:1"), linux);
        assert_eq!(canonical_mac("02-00-00-00-0A-01"), linux);
        assert_eq!(canonical_mac("2:0:0:0:a"), None);
        assert_eq!(canonical_mac("2:0:0:0:a:100"), None);
    }

    #[test]
    fn gateway_id_is_opaque_stable_and_case_blind() {
        let id = gateway_id_of("02:00:00:00:00:01");
        assert_eq!(id.len(), 16);
        assert!(!id.contains(':'));
        assert_eq!(id, gateway_id_of("02:00:00:00:00:01".to_ascii_uppercase().as_str()));
        assert_ne!(id, gateway_id_of("02:00:00:00:00:02"));
    }

    #[test]
    fn null_backend_reports_it_cannot_park() {
        let caps = capabilities_of(&crate::platform::null::NullBackend);
        assert_eq!(caps.backend, "null");
        assert!(!caps.can_park);
    }

    #[test]
    fn empty_net_dir_is_disconnected() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(detect_conn_type_linux(tmp.path()), "disconnected");
    }

    #[test]
    fn loopback_only_is_disconnected() {
        let tmp = tempfile::tempdir().unwrap();
        mk(tmp.path(), "lo", true, false);
        assert_eq!(detect_conn_type_linux(tmp.path()), "disconnected");
    }

    #[test]
    fn ethernet_up_is_lan() {
        let tmp = tempfile::tempdir().unwrap();
        mk(tmp.path(), "eth0", true, false);
        assert_eq!(detect_conn_type_linux(tmp.path()), "lan");
    }

    #[test]
    fn ethernet_down_is_disconnected() {
        let tmp = tempfile::tempdir().unwrap();
        mk(tmp.path(), "eth0", false, false);
        assert_eq!(detect_conn_type_linux(tmp.path()), "disconnected");
    }

    #[test]
    fn wireless_up_is_wlan() {
        let tmp = tempfile::tempdir().unwrap();
        mk(tmp.path(), "wlan0", true, true);
        assert_eq!(detect_conn_type_linux(tmp.path()), "wlan");
    }

    #[test]
    fn wireless_down_is_disconnected() {
        let tmp = tempfile::tempdir().unwrap();
        mk(tmp.path(), "wlan0", false, true);
        assert_eq!(detect_conn_type_linux(tmp.path()), "disconnected");
    }

    #[test]
    fn loopback_plus_ethernet_is_lan() {
        let tmp = tempfile::tempdir().unwrap();
        mk(tmp.path(), "lo", true, false);
        mk(tmp.path(), "eth0", true, false);
        assert_eq!(detect_conn_type_linux(tmp.path()), "lan");
    }

    #[test]
    fn missing_net_dir_is_disconnected() {
        assert_eq!(
            detect_conn_type_linux(std::path::Path::new("/nonexistent/sys/class/net")),
            "disconnected"
        );
    }

    #[test]
    fn network_conn_type_returns_known_value() {
        let val = network_conn_type_blocking();
        assert!(
            ["wlan", "lan", "disconnected"].contains(&val.as_str()),
            "unexpected network type: {val}"
        );
    }

    #[test]
    fn wireless_iface_is_the_one_the_type_probe_picked() {
        let tmp = tempfile::tempdir().unwrap();
        mk(tmp.path(), "lo", true, false);
        mk(tmp.path(), "wlan0", true, true);
        assert_eq!(
            active_wireless_iface(tmp.path()).as_deref(),
            Some("wlan0")
        );
    }

    #[test]
    fn no_wireless_iface_when_only_ethernet_is_up() {
        let tmp = tempfile::tempdir().unwrap();
        mk(tmp.path(), "eth0", true, false);
        mk(tmp.path(), "wlan0", false, true);
        assert_eq!(active_wireless_iface(tmp.path()), None);
    }

    #[test]
    fn nmcli_ssid_takes_the_active_row() {
        let out = "no:Cafe Guest\nyes:Home Network\nno:Neighbour\n";
        assert_eq!(parse_nmcli_ssid(out).as_deref(), Some("Home Network"));
    }

    #[test]
    fn nmcli_ssid_keeps_an_escaped_colon() {
        assert_eq!(
            parse_nmcli_ssid("yes:Floor 2\\: Lab\n").as_deref(),
            Some("Floor 2: Lab")
        );
    }

    #[test]
    fn nmcli_ssid_is_none_when_nothing_is_joined() {
        assert_eq!(parse_nmcli_ssid("no:Cafe Guest\nno:Neighbour\n"), None);
    }

    #[test]
    fn iw_ssid_is_read_from_the_indented_line() {
        let out = "Connected to 00:11:22:33:44:55 (on wlan0)\n\tSSID: Home Network\n\tfreq: 5220\n";
        assert_eq!(parse_iw_ssid(out).as_deref(), Some("Home Network"));
    }

    #[test]
    fn iw_ssid_is_none_when_not_associated() {
        assert_eq!(parse_iw_ssid("Not connected.\n"), None);
    }

    #[test]
    fn netsh_ssid_is_not_the_bssid() {
        let out = "    Name                   : Wi-Fi\n    State                  : connected\n    SSID                   : Home Network\n    BSSID                  : 00:11:22:33:44:55\n";
        assert_eq!(parse_netsh_ssid(out).as_deref(), Some("Home Network"));
    }

    #[test]
    fn airport_ssid_is_none_when_not_associated() {
        assert_eq!(
            parse_airport_ssid("Current Wi-Fi Network: Home Network\n").as_deref(),
            Some("Home Network")
        );
        assert_eq!(
            parse_airport_ssid("You are not associated with an AirPort network.\n"),
            None
        );
    }
}

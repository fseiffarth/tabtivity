//! The in-app browser's engine-side work: reader-mode fetching, the live-page
//! window registry, and download quarantine.
//!
//! # The shape of this feature, and why it is this shape
//!
//! Planner C established that an in-pane embedded child webview is not
//! buildable on Linux: `tauri-runtime-wry` packs a child webview into the
//! window's `default_vbox()` (a `GtkBox`), where wry sets `is_in_fixed_parent =
//! false` and `WebView::set_bounds` becomes a no-op. A GtkBox stacks its
//! children vertically and ignores x/y. So there are two surfaces and neither
//! is an embedded pane:
//!
//! 1. **Reader mode** — this module fetches the page in the *backend*, over
//!    rustls, and runs it through the mail client's `ammonia` pipeline before a
//!    single attacker byte reaches a webview. The frontend renders the result in
//!    an `<iframe sandbox="" srcdoc>`. **No JavaScript ever runs.** Every
//!    property the mail client proved applies unchanged, because it is literally
//!    the same sanitizer.
//! 2. **A live-page window** — a separate hardened `WebviewWindow`, ephemeral
//!    profile, deny-by-default permissions, its own `browser-*` label that no
//!    capability grants anything to. Spawned only by an explicit user action.
//!
//! # Two gaps this design cannot close, disclosed rather than glossed
//!
//! **(a) There is no sub-resource request filter, on any platform.** Tauri's
//! `on_navigation` is wired to WebKitGTK's `decide-policy` for
//! `PolicyDecisionType::NavigationAction` only, which covers top-level *and*
//! iframe navigations but **not** `fetch`/`XHR`/`<img>`/`<script>`.
//! `on_web_resource_request` sounds like the missing hook and is not — its only
//! call site in Tauri is the handler for Tauri's own `tauri://` protocol, and it
//! never fires for an `https://` request. Consequence, stated plainly: **a live
//! page loaded from a public origin can `fetch("http://127.0.0.1:11434/")` and
//! port-scan this machine**, and through an active VPN tunnel it can reach the
//! network that tunnel joined. Nothing here stops that. What bounds it: Tabtivity's
//! own IPC is not an HTTP listener, so a scanner finds no Tabtivity port; the
//! profile is ephemeral, so findings cannot be correlated across sessions; and
//! the *navigation* gate prevents the far worse case of the page **becoming** a
//! local origin — but only when the private address is spelled as a literal
//! (see (c)). Closing it needs an upstream wry/Tauri resource-request hook.
//! Reader mode does not have this gap at all — it has no renderer and no network
//! of its own.
//!
//! **(c) The gate judges a *name*, never the address it resolves to.**
//! [`web_safety::navigation_decision`] classifies `Host::Domain` syntactically:
//! `localhost`, `.local`/`.internal`/`.home.arpa`/`.lan`/`.intranet`, and
//! everything else is "globally routable". It performs no DNS resolution, so a
//! hostname whose A record points inside — a wildcard resolver such as
//! `127-0-0-1.<some-public-wildcard-dns>`, an attacker's own zone, or an
//! organisation's internal name published in public DNS — is judged **Allow**.
//! Two consequences, both real and neither closed here:
//!
//! **The reader half is closed** (`resolve_hop`, below): every hop is resolved
//! before it is connected to, a hop the server chose is refused unless *every*
//! address behind the name is globally routable, and the connection is pinned to
//! the addresses that were checked so DNS cannot answer differently the second
//! time. What remains of (c) is therefore the live window only:
//!
//! - a live page can navigate itself onto a loopback/private service **by name**
//!   and therefore *become* same-origin with it, which is exactly what (a)'s
//!   compensating control was supposed to prevent. It is not fixable from app
//!   code: `on_navigation` is a synchronous callback on the UI thread and WebKit
//!   resolves the name itself afterwards, so any check here is both blocking and
//!   racy. This is the reason the live window is behind its own default-off
//!   setting (`Settings::browser_live_pages`) rather than riding the same flag
//!   that enables the browser.
//!
//! **(d) `ws://` reaches loopback regardless of the scheme allowlist.** `ws`/`wss`
//! are in the hard-blocked list, which reads as protection and is not: wry wires
//! `on_navigation` to `PolicyDecisionType::NavigationAction` only, and
//! `new WebSocket(…)` is not a navigation. WebSocket has **no CORS** — it relies
//! entirely on the server checking `Origin`, which loopback development servers
//! routinely skip — so a live page can both read from and write to a Vite HMR
//! socket, a notebook kernel or a debug adapter. Materially worse than (a), same
//! non-fixability, and the second reason live pages are opt-in.
//!
//! **(b) Autoplay cannot be disabled.** `wry::WebViewAttributes::autoplay`
//! defaults to `true` and Tauri never sets it — the field does not appear in
//! `tauri-runtime` or `tauri-runtime-wry`, so there is no API to turn it off.
//! A live page can play audio and video the instant it loads. Not a
//! confidentiality problem; a startle-and-resources one. Reader mode has no
//! media elements at all (they are not in ammonia's tag allowlist). Fixing it
//! needs `WebviewBuilder::autoplay(bool)` upstream.
//!
//! # The one rule downloads obey
//!
//! **The page chooses the bytes. It never chooses the path.** Every download
//! lands in a quarantine directory Tabtivity picked, is inspected there
//! non-executable, and reaches the user's filesystem only through an OS-native
//! save dialog raised from Rust, one file at a time. Quarantine lives under
//! `<state_dir>/browser/quarantine/` — machine state, deliberately **outside
//! every project tree**, because a file routed into a project can be
//! `git add -A`'d and replicated to a remote host by byte-sync or lockstep.

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use url::Url;

use crate::schema::browser::{SecurityState, TlsState};
use crate::services::mail_sanitize;
use crate::services::web_safety::{
    self, describe_url, navigation_decision, BlockReason, ConfirmReason, NavContext, NavDecision,
};
use crate::storage;

// ── Budgets ─────────────────────────────────────────────────────────────────

/// Largest page reader mode will decode. Matches the mail sanitizer's own cap,
/// deliberately: the same `ammonia` pipeline runs on the result, and its
/// element/nesting budgets are tuned for a body of about this size.
pub const MAX_READER_BYTES: usize = 5 * 1024 * 1024;

/// Wall clock for one reader fetch, connect through last byte.
pub const READER_TIMEOUT: Duration = Duration::from_secs(15);

/// Redirect budget for a reader fetch. Deliberately far below the browser's own
/// [`web_safety::MAX_REDIRECTS`]: a *backend* fetch following a long chain is a
/// server-side-request-forgery amplifier, and three hops covers every real
/// shortener and canonicalization.
pub const MAX_READER_REDIRECTS: usize = 3;

/// Largest single download accepted into quarantine.
pub const MAX_DOWNLOAD_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// How many leading bytes are sniffed for the content check.
pub const SNIFF_BYTES: usize = 8192;

/// Longest page title kept.
const MAX_TITLE_CHARS: usize = 200;

/// A fixed, generic user agent. Not the OS's, not a real browser's version
/// string, not anything that varies between users — a reader fetch should not
/// be a fingerprint, and pretending to be a specific Chrome build would be a
/// lie that breaks the day sites start branching on it.
const READER_USER_AGENT: &str = concat!("Mozilla/5.0 (compatible; ", crate::app_name!(), " Reader)");

// ── Where things live ───────────────────────────────────────────────────────

/// The one directory the browser subsystem may touch. Machine-level, beside the
/// mail store and the VPN configs — never inside a project, because a project
/// tree is a git working copy that other subsystems replicate.
pub fn browser_dir() -> PathBuf {
    storage::state_dir().join("browser")
}

pub fn quarantine_root() -> PathBuf {
    browser_dir().join("quarantine")
}

/// Create a directory `0700` on Unix. Quarantine holds bytes the user has not
/// consented to yet; group and other have no business reading them.
fn create_private_dir(path: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

/// Delete everything under a quarantine root and recreate it empty.
///
/// Called at startup, the same posture `services::sandbox::sweep_orphans` takes
/// with stale containers: anything left here from a previous run is by
/// definition abandoned — the user either saved it (in which case the saved copy
/// is elsewhere) or did not (in which case they declined it).
pub fn sweep_quarantine_at(root: &Path) -> std::io::Result<()> {
    if root.exists() {
        std::fs::remove_dir_all(root)?;
    }
    create_private_dir(root)
}

pub fn sweep_quarantine() {
    let _ = sweep_quarantine_at(&quarantine_root());
}

// ── Download naming and staging ─────────────────────────────────────────────

/// Derive a display/save name for a download from its URL.
///
/// The filename source is attacker-controlled: the URL path (and, where an
/// engine exposes it, `Content-Disposition`, which Tauri's `on_download` does
/// not). It goes through the **shared** `web_safety::sanitize_attachment_name`,
/// the same one the mail client's attachments use — one implementation, one test
/// table, one set of bugs.
///
/// One browser-specific rule on top: **if the result has no extension, do not
/// invent one.** An extensionless file is harmless; a guessed `.exe` is not.
pub fn download_name_for(url: &Url) -> String {
    let last = url
        .path_segments()
        .and_then(|mut s| s.next_back().map(str::to_string))
        .unwrap_or_default();
    // Percent-decoding happens *before* sanitizing, because `%2e%2e%2f` is the
    // classic order-of-operations bypass and the sanitizer expects a decoded
    // name.
    let decoded = percent_decode(&last);
    let candidate = if decoded.trim().is_empty() {
        "download".to_string()
    } else {
        decoded
    };
    let safe = web_safety::sanitize_attachment_name(&candidate);
    if safe.value.is_empty() {
        "download".to_string()
    } else {
        safe.value
    }
}

/// Minimal, total percent-decoding. Invalid escapes are left verbatim rather
/// than dropped — a name that decodes to something different from what a
/// stricter decoder saw is how two layers disagree.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(v) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Where one download is staged. `token` is a freshly minted opaque id, so two
/// downloads with the same name never collide and no name can address another
/// download's directory.
///
/// The name has already been through [`download_name_for`], which strips every
/// path separator, so the join cannot escape — and the test below asserts that
/// over ten thousand hostile names rather than trusting the argument.
pub fn quarantine_dest(root: &Path, token: &str, name: &str) -> PathBuf {
    let safe_token: String = token
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    let safe_name = web_safety::sanitize_attachment_name(name).value;
    root.join(if safe_token.is_empty() {
        "download".to_string()
    } else {
        safe_token
    })
    .join(safe_name)
}

/// Take every execute bit off a staged file and make it owner-only.
///
/// After the move to the user's chosen path the mode is **not** re-applied — the
/// file inherits the user's umask like any other saved file. It just never
/// *gains* `+x` from us.
pub fn harden_staged_file(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

/// What the bytes turned out to be.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Classification {
    /// Nothing to say.
    Ok,
    /// The sniffed type disagrees with what the name claims.
    TypeMismatch,
    /// The bytes are an executable, whatever the name says. **Labelled, not
    /// refused** — people download installers, and a browser that cannot is
    /// broken. This is exactly where the browser is deliberately less strict
    /// than the mail client, which does refuse.
    IsAProgram,
}

/// Extensions that name a program on some platform. Same list the mail client
/// uses for its executable-attachment warning.
const EXECUTABLE_EXTENSIONS: &[&str] = &[
    "exe",
    "com",
    "scr",
    "pif",
    "bat",
    "cmd",
    "msi",
    "msp",
    "cpl",
    "hta",
    "js",
    "jse",
    "vbs",
    "vbe",
    "wsf",
    "wsh",
    "ps1",
    "psm1",
    "sh",
    "bash",
    "zsh",
    "jar",
    "apk",
    "app",
    "dmg",
    "pkg",
    "lnk",
    "url",
    "scf",
    "reg",
    "inf",
    "desktop",
    "appref-ms",
    "library-ms",
    "gadget",
    "chm",
    "msc",
    "ade",
    "adp",
    "mde",
    "mdb",
];

/// Does the head of the file look like a program, regardless of its name?
///
/// This is the check that catches `holiday-photos.zip` that is really a Mach-O,
/// and it is why the classification is not driven by the extension alone.
pub fn sniffs_as_executable(head: &[u8]) -> bool {
    const MACHO: &[&[u8]] = &[
        &[0xFE, 0xED, 0xFA, 0xCE],
        &[0xFE, 0xED, 0xFA, 0xCF],
        &[0xCE, 0xFA, 0xED, 0xFE],
        &[0xCF, 0xFA, 0xED, 0xFE],
        // Universal binary / Java class share `CAFEBABE`; both are executable
        // content, so the ambiguity does not change the answer.
        &[0xCA, 0xFE, 0xBA, 0xBE],
    ];
    head.starts_with(b"MZ")
        || head.starts_with(b"\x7fELF")
        || head.starts_with(b"#!")
        || MACHO.iter().any(|m| head.starts_with(m))
}

/// Three signals, exactly as the mail client does it: **sniffed** (`infer` over
/// the head), **implied** (`mime_guess` from the sanitized name), and the
/// name's own extension. Tauri's `on_download` does not surface the response's
/// `Content-Type`, so the *declared* signal is unavailable here — noted rather
/// than faked.
pub fn classify(head: &[u8], name: &str) -> Classification {
    if sniffs_as_executable(head) {
        return Classification::IsAProgram;
    }
    let lower = name.to_ascii_lowercase();
    let ext = lower.rsplit('.').next().unwrap_or_default();
    let has_ext = lower.contains('.');
    if has_ext && EXECUTABLE_EXTENSIONS.contains(&ext) {
        return Classification::IsAProgram;
    }
    // A zip carrying a JVM manifest is a runnable jar wearing a `.zip`.
    if head.starts_with(b"PK\x03\x04")
        && head
            .windows(b"META-INF/MANIFEST.MF".len())
            .any(|w| w == b"META-INF/MANIFEST.MF")
    {
        return Classification::IsAProgram;
    }

    let sniffed = infer::get(head).map(|t| t.mime_type().to_string());
    let implied = mime_guess::from_path(name).first().map(|m| m.to_string());
    match (sniffed, implied) {
        (Some(s), Some(i)) if s != i && !zip_container_alias(&s, &i) => {
            Classification::TypeMismatch
        }
        // `infer` recognizes no text formats, so a `.txt` or `.html` with no
        // magic is the normal case and must not read as a mismatch.
        _ => Classification::Ok,
    }
}

/// A great many formats *are* zip files — `.docx`, `.xlsx`, `.odt`, `.epub`,
/// `.apk`. When `infer` only gets as far as "this is a zip" and the name claims
/// one of them, that agreement is real, not a mismatch. The reverse (a name
/// claiming `.zip` over bytes that sniff as something else) is still reported.
fn zip_container_alias(sniffed: &str, implied: &str) -> bool {
    if sniffed != "application/zip" {
        return false;
    }
    const ZIP_BASED: &[&str] = &[
        "openxmlformats",
        "oasis.opendocument",
        "epub+zip",
        "java-archive",
        "vnd.android.package-archive",
        "vnd.ms-",
    ];
    ZIP_BASED.iter().any(|m| implied.contains(m))
}

/// The MIME the UI shows, preferring what the bytes actually are.
pub fn best_mime(head: &[u8], name: &str) -> Option<String> {
    infer::get(head)
        .map(|t| t.mime_type().to_string())
        .or_else(|| mime_guess::from_path(name).first().map(|m| m.to_string()))
}

// ── Live-window registry ────────────────────────────────────────────────────

/// What the backend knows about one live-page window.
#[derive(Debug, Clone)]
pub struct LiveRecord {
    pub label: String,
    pub url: Url,
    pub title: String,
    /// Non-globally-routable hosts the user has already accepted for **this**
    /// window. Seeded with the host it was opened on, because opening it *was*
    /// the confirmation. A navigation to a private address that is not in here
    /// is refused and reported as `browser:blocked`, so the "Open anyway, once"
    /// decision always goes back through a user action rather than being
    /// something a page can take on its own.
    pub approved_hosts: HashSet<String>,
}

fn live_registry() -> &'static Mutex<HashMap<String, LiveRecord>> {
    static LIVE: OnceLock<Mutex<HashMap<String, LiveRecord>>> = OnceLock::new();
    LIVE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Mint the next live-window label.
///
/// The `browser-` prefix is the whole of BC-3: `capabilities/browser.json`
/// matches it and grants nothing, and `capabilities/default.json` matches
/// `main`/`detached-*`/`present-*` and therefore never matches this. A label
/// outside this shape would silently land in nobody's capability, which is safe
/// but confusing, so the shape is also validated on the way in.
pub fn next_live_label() -> String {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("browser-{n}")
}

/// Whether a label is one the browser commands may act on. Mirrors
/// `presenter::valid_presenter_label`: without it, `browser_close_live` would
/// take a label from the frontend and destroy any window in the app, `main`
/// included.
pub fn valid_live_label(label: &str) -> bool {
    label.len() <= 64
        && label.len() > "browser-".len()
        && label.starts_with("browser-")
        && label
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn live_register(label: &str, url: &Url) {
    let mut approved = HashSet::new();
    if let Some(h) = url.host_str() {
        approved.insert(h.to_ascii_lowercase());
    }
    if let Ok(mut map) = live_registry().lock() {
        map.insert(
            label.to_string(),
            LiveRecord {
                label: label.to_string(),
                url: url.clone(),
                title: String::new(),
                approved_hosts: approved,
            },
        );
    }
}

pub fn live_get(label: &str) -> Option<LiveRecord> {
    live_registry().lock().ok()?.get(label).cloned()
}

pub fn live_set_url(label: &str, url: &Url) {
    if let Ok(mut map) = live_registry().lock() {
        if let Some(rec) = map.get_mut(label) {
            rec.url = url.clone();
        }
    }
}

pub fn live_set_title(label: &str, title: &str) {
    if let Ok(mut map) = live_registry().lock() {
        if let Some(rec) = map.get_mut(label) {
            rec.title = web_safety::strip_format_controls(title);
        }
    }
}

pub fn live_forget(label: &str) {
    if let Ok(mut map) = live_registry().lock() {
        map.remove(label);
    }
}

pub fn live_list() -> Vec<LiveRecord> {
    let Ok(map) = live_registry().lock() else {
        return Vec::new();
    };
    let mut out: Vec<LiveRecord> = map.values().cloned().collect();
    out.sort_by(|a, b| a.label.cmp(&b.label));
    out
}

/// The decision a live window's `on_navigation` handler makes.
///
/// Split out as a pure function taking the record, so the whole policy is
/// testable without a webview: the handler itself is three lines of glue around
/// this.
pub fn live_navigation_allowed(rec: &LiveRecord, target: &Url) -> Result<(), String> {
    let ctx = NavContext {
        current: Some(rec.url.clone()),
        redirects: 0,
    };
    match navigation_decision(target, &ctx) {
        NavDecision::Allow => Ok(()),
        NavDecision::Block(r) => Err(r.token()),
        NavDecision::Confirm(r) => {
            let host = target.host_str().unwrap_or_default().to_ascii_lowercase();
            if rec.approved_hosts.contains(&host) {
                Ok(())
            } else {
                Err(r.token().to_string())
            }
        }
    }
}

// ── Pending downloads ───────────────────────────────────────────────────────

/// A download staged in quarantine, waiting for the user's decision.
#[derive(Debug, Clone)]
pub struct PendingDownload {
    pub id: String,
    /// The per-download directory. Deleted whole on either decision, so a
    /// declined download leaves nothing at all.
    pub dir: PathBuf,
    pub file: PathBuf,
    pub name: String,
    pub mime: Option<String>,
    pub size: Option<u64>,
    pub classification: Classification,
}

fn downloads() -> &'static Mutex<HashMap<String, PendingDownload>> {
    static D: OnceLock<Mutex<HashMap<String, PendingDownload>>> = OnceLock::new();
    D.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Where a download was staged, keyed by the URL it was requested for.
///
/// Required, not an optimization: on macOS `DownloadEvent::Finished` reports
/// `path: None` unconditionally (a documented API limitation), so the
/// destination has to be remembered from `Requested` rather than read back from
/// the event.
fn staging() -> &'static Mutex<HashMap<String, (String, PathBuf)>> {
    static S: OnceLock<Mutex<HashMap<String, (String, PathBuf)>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn stage_remember(url: &str, token: &str, dest: &Path) {
    if let Ok(mut m) = staging().lock() {
        m.insert(url.to_string(), (token.to_string(), dest.to_path_buf()));
    }
}

pub fn stage_take(url: &str) -> Option<(String, PathBuf)> {
    staging().lock().ok()?.remove(url)
}

pub fn download_remember(pending: PendingDownload) {
    if let Ok(mut m) = downloads().lock() {
        m.insert(pending.id.clone(), pending);
    }
}

pub fn download_take(id: &str) -> Option<PendingDownload> {
    downloads().lock().ok()?.remove(id)
}

/// Forget and delete every pending download. Used by `browser_clear_data` and
/// at teardown.
pub fn downloads_clear() {
    if let Ok(mut m) = downloads().lock() {
        for (_, p) in m.drain() {
            let _ = std::fs::remove_dir_all(&p.dir);
        }
    }
    if let Ok(mut m) = staging().lock() {
        m.clear();
    }
}

// ── Reader mode ─────────────────────────────────────────────────────────────

/// The result of a reader fetch, before it is shaped into the IPC type.
#[derive(Debug, Clone)]
pub struct FetchedPage {
    pub final_url: Url,
    pub title: String,
    pub html: String,
    pub truncated: bool,
    pub blocked_remote: u32,
    pub tls: TlsState,
}

/// Content types reader mode knows how to render. Anything else is refused with
/// a typed error naming the type, so the frontend can offer *Open live page*
/// rather than showing a blank pane.
fn readable_content_type(ct: &str) -> Option<bool> {
    let base = ct
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match base.as_str() {
        "" | "text/html" | "application/xhtml+xml" | "application/xml" | "text/xml" => Some(true),
        "text/plain" | "text/markdown" => Some(false),
        _ => None,
    }
}

/// Charset label from a `Content-Type`, then from an early `<meta charset>`,
/// then UTF-8. **Never** the renderer's own sniffing — that is the layer whose
/// disagreement with ours would be the bug.
fn decode_body(bytes: &[u8], content_type: &str) -> String {
    let label = content_type
        .split(';')
        .skip(1)
        .filter_map(|p| {
            let p = p.trim();
            p.strip_prefix("charset=")
                .or_else(|| p.strip_prefix("charset ="))
        })
        .map(|v| v.trim_matches('"').trim().to_string())
        .next()
        .or_else(|| meta_charset(&bytes[..bytes.len().min(2048)]));

    let encoding = label
        .as_deref()
        .and_then(|l| encoding_rs::Encoding::for_label(l.as_bytes()))
        .unwrap_or(encoding_rs::UTF_8);
    let (text, _, _) = encoding.decode(bytes);
    text.into_owned()
}

fn meta_charset(head: &[u8]) -> Option<String> {
    let s = String::from_utf8_lossy(head).to_ascii_lowercase();
    let idx = s.find("charset")?;
    let rest = &s[idx + "charset".len()..];
    let rest = rest.trim_start().strip_prefix('=')?.trim_start();
    // A quoted value terminates on its own quote; an unquoted one on the next
    // delimiter. Looking for `"` in both cases would find the OPENING quote and
    // yield an empty label — which reads as "no charset declared" and silently
    // decodes the page as UTF-8.
    let (rest, terminators): (&str, &[char]) = match rest.chars().next() {
        Some('"') => (&rest[1..], &['"']),
        Some('\'') => (&rest[1..], &['\'']),
        _ => (rest, &['>', ';', ' ', '\t', '\r', '\n', '/']),
    };
    let end = rest
        .find(|c: char| terminators.contains(&c))
        .unwrap_or(rest.len());
    let label = rest[..end].trim();
    if label.is_empty() {
        None
    } else {
        Some(label.to_string())
    }
}

/// Pull the `<title>` out of the RAW document, before sanitizing — ammonia
/// removes `<title>` **with its contents** (it is one of the elements the
/// renderer re-parses differently, i.e. a classic mXSS site), so after the
/// sanitizer there is nothing left to read.
pub fn extract_title(raw: &str) -> String {
    let lower = raw.to_ascii_lowercase();
    let Some(open) = lower.find("<title") else {
        return String::new();
    };
    let Some(gt) = lower[open..].find('>') else {
        return String::new();
    };
    let start = open + gt + 1;
    let end = lower[start..]
        .find("</title")
        .map(|i| start + i)
        .unwrap_or(raw.len());
    let text = &raw[start..end.min(raw.len())];
    let text = text
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ");
    // A title is a label rendered in Tabtivity's own chrome, so bidi and format
    // controls come out: `example.com — Secure  \u{2069}` is a real technique.
    let text = web_safety::strip_format_controls(&text);
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    text.chars().take(MAX_TITLE_CHARS).collect()
}

/// Decide whether one reader hop may proceed.
///
/// Hop 0 is the URL the **user** asked for, so a loopback or private address is
/// allowed — a developer reading their own dev server's docs is a real thing,
/// and it is a user action, not a page's.
///
/// Every later hop is chosen by the **server**, so a private address there is a
/// redirect into the machine's own network from a public page: the classic
/// server-side-request-forgery step, and the reason `169.254.169.254` is on
/// every SSRF cheat sheet. Those are refused outright.
///
/// **Scope:** this function judges the address *literal* only — it is pure, and
/// a pure function cannot resolve. A later hop to a **hostname** that resolves
/// inside (`169.254.169.254` by way of a wildcard resolver, say) passes here and
/// is caught by [`resolve_hop`], which runs on every hop of a reader fetch and
/// pins the connection to the addresses it checked. Neither is sufficient alone:
/// this one bounds the spelling, that one bounds the resolution.
pub fn reader_hop_allowed(url: &Url, previous: Option<&Url>, hop: usize) -> Result<(), String> {
    hop_allowed(url, previous, hop, FetchOrigin::User)
}

/// Who chose the first URL of a backend fetch, which decides how far into the
/// machine's own network that first hop may reach.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FetchOrigin {
    /// Typed or clicked by the user (a reader tab, a calendar feed): hop 0 may
    /// be a loopback or private address, as [`reader_hop_allowed`] explains.
    User,
    /// Named by a document's *contents* (an image in a markdown preview). The
    /// user agreed to fetch the document's images, not to aim a request at a
    /// particular address, so hop 0 is judged as though a server had chosen it —
    /// no loopback, no private network — and every hop must be `https`.
    Document,
}

fn hop_allowed(url: &Url, previous: Option<&Url>, hop: usize, origin: FetchOrigin) -> Result<(), String> {
    if hop > MAX_READER_REDIRECTS {
        return Err(BlockReason::RedirectLoop.token());
    }
    let https_only = origin == FetchOrigin::Document;
    if url.scheme() != "https" && (https_only || url.scheme() != "http") {
        return Err(BlockReason::Scheme(url.scheme().to_ascii_lowercase()).token());
    }
    let ctx = NavContext {
        current: previous.cloned(),
        redirects: hop,
    };
    match navigation_decision(url, &ctx) {
        NavDecision::Allow => Ok(()),
        NavDecision::Block(r) => Err(r.token()),
        NavDecision::Confirm(r) => match (origin, hop) {
            (FetchOrigin::User, 0) => Ok(()),
            (FetchOrigin::Document, 0) => Err(r.token().to_string()),
            _ => Err(format!("redirect-to-{}", r.token())),
        },
    }
}

/// Fetch raw bytes with the reader's whole network discipline — hop 0 vs.
/// later-hop SSRF judging, DNS-pinned redirect following, the size cap — but
/// none of the HTML-specific decisions (content-type gate, sanitize). Shared
/// by [`fetch_reader`] and `commands::calendar`'s ICS-subscription fetch,
/// which both need the same "may this backend touch this URL" answer and would
/// otherwise carry two copies of the SSRF defence to keep in sync.
async fn fetch_raw(raw: &str) -> Result<(Vec<u8>, String, Url, bool), String> {
    fetch_raw_from(raw, FetchOrigin::User).await
}

async fn fetch_raw_from(raw: &str, origin: FetchOrigin) -> Result<(Vec<u8>, String, Url, bool), String> {
    let mut url = Url::parse(raw).map_err(|_| BlockReason::Unparsable.token())?;
    hop_allowed(&url, None, 0, origin)?;

    let mut hop = 0usize;
    let response = loop {
        // Resolve BEFORE connecting, judge the addresses, then pin them — see
        // `resolve_hop`. The client is rebuilt per hop because the pin is a
        // builder-level setting; three hops of client construction is nothing
        // against one network round trip, and sharing a client across hops would
        // mean the pin for hop 1 still applied at hop 2.
        let pin = resolve_hop(&url, hop, origin).await?;
        let client = reader_client(pin.as_ref())?;
        let resp = client
            .get(url.clone())
            .send()
            .await
            .map_err(|e| format!("fetch-failed: {}", tidy_transport_error(&e.to_string())))?;
        let status = resp.status();
        if status.is_redirection() {
            let location = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| "redirect-without-location".to_string())?;
            let next = url
                .join(location)
                .map_err(|_| BlockReason::Unparsable.token())?;
            hop += 1;
            hop_allowed(&next, Some(&url), hop, origin)?;
            url = next;
            continue;
        }
        if !status.is_success() {
            return Err(format!("http-status:{}", status.as_u16()));
        }
        break resp;
    };

    let final_url = response.url().clone();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    // Read with a hard cap rather than `bytes()`: a hostile (or merely huge)
    // response must not be able to decide how much memory this process uses.
    let mut body: Vec<u8> = Vec::new();
    let mut response = response;
    let mut over_cap = false;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("fetch-failed: {}", tidy_transport_error(&e.to_string())))?
    {
        if body.len() + chunk.len() > MAX_READER_BYTES {
            let room = MAX_READER_BYTES.saturating_sub(body.len());
            body.extend_from_slice(&chunk[..room]);
            over_cap = true;
            break;
        }
        body.extend_from_slice(&chunk);
    }

    Ok((body, content_type, final_url, over_cap))
}

/// Fetch a page and sanitize it. **The whole point is where this runs**: in the
/// backend, so the unsanitized bytes never exist inside a webview process at
/// all. A frontend sanitizer would mean the raw attacker HTML is already a JS
/// string in the app origin when sanitization runs, and any bug in the
/// surrounding code — a stray log, a devtools hook, a refactor that renders
/// before it sanitizes — is app-origin XSS with a live IPC bridge.
pub async fn fetch_reader(raw: &str) -> Result<FetchedPage, String> {
    let (body, content_type, final_url, over_cap) = fetch_raw(raw).await?;
    let is_html = readable_content_type(&content_type)
        .ok_or_else(|| format!("unsupported-content-type:{content_type}"))?;

    let text = decode_body(&body, &content_type);
    let title = if is_html {
        extract_title(&text)
    } else {
        String::new()
    };

    // THE sanitizer — the mail client's, unchanged. No `href` survives, no
    // attribute can load anything remote, and `script`/`style`/`noscript` are
    // removed with their contents.
    let source = if is_html {
        text
    } else {
        mail_sanitize::plain_text_to_html(&text)
    };
    let clean = mail_sanitize::sanitize_message_html(&source).map_err(|e| e.to_string())?;

    Ok(FetchedPage {
        tls: if final_url.scheme() == "https" {
            TlsState::Secure
        } else {
            TlsState::Insecure
        },
        title,
        html: clean.html,
        truncated: clean.truncated || over_cap,
        blocked_remote: clean.remote_refs,
        final_url,
    })
}

/// Fetch an `.ics` subscription feed (the calendar's "Refresh from URL",
/// `commands::calendar::calendar_fetch_ics`) and decode it to text.
///
/// Deliberately **not** `fetch_reader`: an ICS body is handed to
/// `src/lib/calendar/ics.ts`'s parser, never rendered as markup, so there is nothing
/// here for the mail sanitizer to do — it would only risk mangling a `\n`
/// inside a folded content line. The SSRF defence (hop judging, DNS pinning,
/// the size cap) is `fetch_raw`'s and is identical to the reader's.
///
/// The one content check that *is* worth making: a feed URL is something the
/// user pasted once and this runs on every click of "Refresh", so a redirect
/// to a login page or an expired link should fail loudly rather than hand the
/// frontend parser an HTML document it will silently import zero events from.
pub async fn fetch_ics(raw: &str) -> Result<String, String> {
    let (body, content_type, _final_url, _over_cap) = fetch_raw(raw).await?;
    let text = decode_body(&body, &content_type);
    if !text
        .trim_start_matches('\u{feff}')
        .trim_start()
        .starts_with("BEGIN:VCALENDAR")
    {
        return Err("not-icalendar".to_string());
    }
    Ok(text)
}

/// Cap on one image a document names. A README badge is a few kilobytes; the
/// bytes cross the IPC boundary as base64, so the reader's 5 MB page cap would
/// be far more than a preview image has any business costing.
pub const MAX_DOCUMENT_IMAGE_BYTES: usize = 2 * 1024 * 1024;

/// The raster and vector formats an `<img>` can show. Anything else a server
/// answers with — an HTML login page, a JSON error — is refused rather than
/// handed to the webview as a blob of unknown type.
const DOCUMENT_IMAGE_TYPES: &[&str] = &[
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
    "image/bmp",
    "image/svg+xml",
    "image/x-icon",
    "image/vnd.microsoft.icon",
];

pub struct DocumentImage {
    pub mime: String,
    pub bytes: Vec<u8>,
}

/// The accepted image type for a `Content-Type` header, or `None`.
pub fn document_image_mime(content_type: &str) -> Option<&'static str> {
    let essence = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    DOCUMENT_IMAGE_TYPES.iter().copied().find(|t| *t == essence)
}

/// Fetch one remote image a markdown document names — only ever after the user
/// clicked "Load" on that document (`commands::markdown`).
///
/// The page's CSP stays `img-src 'self' data: blob:`, so a document can never
/// make the webview reach the network by itself; this is the one door, and it is
/// narrower than the reader's. The URL is the *document's* choice, so
/// [`FetchOrigin::Document`] applies to every hop: `https` only, and no address
/// on this machine or its local network (which is also what stops a planted
/// file from turning a preview into requests against a LAN device). No cookies,
/// no `Referer` — `reader_client`'s properties, unchanged. An SVG is safe to
/// return: the frontend shows it through `<img>`, where it runs no script and
/// loads nothing.
pub async fn fetch_document_image(raw: &str) -> Result<DocumentImage, String> {
    let (body, content_type, _final_url, over_cap) =
        fetch_raw_from(raw.trim(), FetchOrigin::Document).await?;
    if over_cap || body.len() > MAX_DOCUMENT_IMAGE_BYTES {
        return Err("image-too-large".to_string());
    }
    let mime = document_image_mime(&content_type)
        .ok_or_else(|| format!("unsupported-content-type:{content_type}"))?;
    Ok(DocumentImage {
        mime: mime.to_string(),
        bytes: body,
    })
}

/// Build the reader's HTTP client.
///
/// Split out so it can be constructed in a unit test: `reqwest` is compiled
/// with `rustls-no-provider`, i.e. it takes the process-default
/// `CryptoProvider`, and rustls 0.23 **panics** rather than erroring when none
/// is installed. That panic would happen on a user's machine, inside a
/// command, the first time they opened a reader tab — so the install is done
/// here (idempotent, and independent of whether the mail client was ever
/// touched) and a test builds the client to prove it.
///
/// The client itself has **no cookie store** (the `cookies` feature is off),
/// sends no `Referer`, follows no redirect of its own, and validates against
/// the OS trust store via `rustls-native-certs`. There is no knob anywhere on
/// it for ignoring a certificate error.
///
/// `pin` is the `(hostname, addresses)` pair [`resolve_hop`] already checked. It
/// is what makes that check mean anything: without it the resolver is consulted
/// a second time when the connection is made, and a hostile authoritative server
/// answering with a public address for the check and a private one for the
/// connect walks straight through. This is the DNS-rebinding shape, and a
/// check-then-connect gate that does not pin is decoration.
fn reader_client(pin: Option<&(String, Vec<SocketAddr>)>) -> Result<reqwest::Client, String> {
    crate::services::mail_engine::install_crypto_provider();
    let mut builder = reqwest::Client::builder()
        .user_agent(READER_USER_AGENT)
        // Every hop is re-checked by us, so the client must not follow any on
        // its own — an automatic redirect is a hop the gate never sees.
        .redirect(reqwest::redirect::Policy::none())
        .timeout(READER_TIMEOUT)
        // No `Referer`: a reader fetch must not tell the destination which page
        // the URL came from.
        .referer(false);
    if let Some((host, addrs)) = pin {
        builder = builder.resolve_to_addrs(host, addrs);
    }
    builder.build().map_err(|e| format!("reader-client: {e}"))
}

/// Resolve one reader hop's hostname and judge the **addresses** behind it.
///
/// This is the other half of [`reader_hop_allowed`], and the half that closes
/// disclosed gap (c) for reader mode. `reader_hop_allowed` judges the *name*
/// syntactically, which is all a pure function can do; a name like
/// `127-0-0-1.<a public wildcard resolver>` is a perfectly ordinary domain by
/// that measure and resolves to loopback. So each hop is resolved here, and a
/// hop the **server** chose (`hop > 0`) is refused unless *every* address behind
/// it is globally routable — every, not any, because a name with one public and
/// one private answer is a rebinding primitive, not a compromise.
///
/// Hop 0 keeps the same allowance the syntactic gate gives it: the user asked
/// for it, and reading your own dev server is the point. Its addresses are still
/// returned, because pinning hop 0 costs nothing and keeps one code path.
///
/// Returns `None` when the URL's host is already an IP literal — there is no
/// name for DNS to change its mind about, and `reader_hop_allowed` has judged it.
///
/// A [`FetchOrigin::Document`] fetch gets the later-hop rule on hop 0 as well:
/// the address came out of a file, not from the user.
async fn resolve_hop(
    url: &Url,
    hop: usize,
    origin: FetchOrigin,
) -> Result<Option<(String, Vec<SocketAddr>)>, String> {
    let Some(url::Host::Domain(name)) = url.host() else {
        return Ok(None);
    };
    let name = name.to_string();
    let port = url
        .port_or_known_default()
        .ok_or_else(|| BlockReason::NoHost.token())?;
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((name.as_str(), port))
        .await
        .map_err(|e| format!("fetch-failed: {}", tidy_transport_error(&e.to_string())))?
        .collect();
    if addrs.is_empty() {
        return Err("fetch-failed: name resolved to no address".to_string());
    }
    if hop > 0 || origin == FetchOrigin::Document {
        for addr in &addrs {
            if !address_is_global(addr.ip()) {
                // Reuses the existing `redirect-to-*` vocabulary rather than
                // minting a token for "resolved somewhere private": to the user
                // the two are the same event, and a new token would be a new
                // untranslated string. A document's own first hop was not a
                // redirect, so it carries the plain reach token instead.
                let reason = reach_reason(addr.ip()).token();
                return Err(if hop > 0 {
                    format!("redirect-to-{reason}")
                } else {
                    reason.to_string()
                });
            }
        }
    }
    Ok(Some((name, addrs)))
}

/// IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is the same address as its IPv4 form
/// and must be judged as one — a resolver may hand back either.
fn unmap(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6
            .to_ipv4_mapped()
            .map(IpAddr::V4)
            .unwrap_or(IpAddr::V6(v6)),
        v4 => v4,
    }
}

/// Whether a *resolved* address is one a server-chosen hop may point at.
/// Delegates to the same `web_safety` classifier the syntactic gate uses, so the
/// two halves cannot disagree about what "private" means.
fn address_is_global(ip: IpAddr) -> bool {
    match unmap(ip) {
        IpAddr::V4(v4) => web_safety::is_globally_routable(&url::Host::<&str>::Ipv4(v4)),
        IpAddr::V6(v6) => web_safety::is_globally_routable(&url::Host::<&str>::Ipv6(v6)),
    }
}

/// Which flavour of "not the public internet" an address is, for the message.
fn reach_reason(ip: IpAddr) -> ConfirmReason {
    match unmap(ip) {
        IpAddr::V4(v4) if v4.is_loopback() => ConfirmReason::Loopback,
        IpAddr::V4(v4) if v4.is_link_local() => ConfirmReason::LinkLocal,
        IpAddr::V6(v6) if v6.is_loopback() => ConfirmReason::Loopback,
        // `fe80::/10`.
        IpAddr::V6(v6) if (v6.segments()[0] & 0xffc0) == 0xfe80 => ConfirmReason::LinkLocal,
        _ => ConfirmReason::PrivateNetwork,
    }
}

/// Transport errors quote the URL, which puts a user-supplied string into a
/// message the UI renders. Keep the reason, drop the echo.
fn tidy_transport_error(msg: &str) -> String {
    // A word "containing" a scheme, not one starting with it: the URL is
    // normally parenthesized (`for url (https://…):`), so a `starts_with`
    // filter would let the whole thing through.
    let cleaned: String = msg
        .split_whitespace()
        .filter(|w| !w.contains("://"))
        .collect::<Vec<_>>()
        .join(" ");
    web_safety::strip_format_controls(&cleaned)
        .chars()
        .take(200)
        .collect()
}

// ── Security readout ────────────────────────────────────────────────────────

/// Whether an OpenVPN tunnel Tabtivity started (or adopted) is up.
///
/// The browser makes **no** attempt to route around it. A per-webview proxy
/// that bypassed the tunnel would be a split tunnel Tabtivity invented, silently
/// contradicting what the user's `.ovpn` asked for and what the header's VPN
/// indicator says — a user who turned on a VPN to browse safely would be
/// browsing outside it *because of* a security feature. So this is reported,
/// never acted on.
pub fn vpn_active() -> bool {
    !crate::services::openvpn::active_configs().is_empty()
}

/// Build the chrome's security readout for a URL.
pub fn security_for(url: &Url, tls: TlsState) -> SecurityState {
    let d = describe_url(url);
    SecurityState {
        tls,
        scheme: url.scheme().to_string(),
        host_display: d.host,
        punycode_warning: d.punycode,
        vpn_active: vpn_active(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    // ── Quarantine ──────────────────────────────────────────────────────────

    /// The property the whole download boundary rests on: whatever the page
    /// calls the file, the bytes land under the directory **we** chose.
    #[test]
    fn a_staged_download_can_never_escape_the_quarantine_root() {
        let root = Path::new(concat!("/var/state/", crate::app_slug!(), "/browser/quarantine"));
        let hostile = [
            "../../etc/passwd",
            "..\\..\\windows\\system32\\cmd.exe",
            "/etc/shadow",
            "C:\\Windows\\evil.exe",
            "....//....//x",
            "%2e%2e%2fetc%2fpasswd",
            "a/../../..",
            "..",
            ".",
            "",
            "\u{202E}gnp.exe",
            "con",
            "-rf",
            &"x".repeat(500),
        ];
        for (i, name) in hostile.iter().enumerate() {
            let dest = quarantine_dest(root, &format!("tok{i}"), name);
            assert!(
                dest.starts_with(root),
                "`{name}` escaped the root: {dest:?}"
            );
            assert!(
                !dest
                    .components()
                    .any(|c| matches!(c, std::path::Component::ParentDir)),
                "`{name}` produced a `..` component: {dest:?}"
            );
            // Root + token + name, and nothing else.
            assert_eq!(dest.components().count(), root.components().count() + 2);
        }
    }

    /// A token from anywhere but our own minting must not be able to address a
    /// sibling directory either.
    #[test]
    fn a_hostile_token_cannot_redirect_the_staging_directory() {
        let root = Path::new("/tmp/q");
        for token in ["../..", "/etc", "a/b", "..", ""] {
            let dest = quarantine_dest(root, token, "file.bin");
            assert!(dest.starts_with(root), "{token} -> {dest:?}");
            assert_eq!(dest.components().count(), root.components().count() + 2);
        }
    }

    #[test]
    fn download_names_come_from_the_url_and_never_invent_an_extension() {
        assert_eq!(
            download_name_for(&u("https://example.com/a/report.pdf")),
            "report.pdf"
        );
        // No extension in, no extension out. A guessed `.exe` is not harmless.
        let n = download_name_for(&u("https://example.com/a/blob"));
        assert_eq!(n, "blob");
        assert!(!n.contains('.'));
        // Percent-encoded traversal is decoded *before* sanitizing, which is
        // the whole reason the order matters.
        assert_eq!(
            download_name_for(&u("https://example.com/%2e%2e%2f%2e%2e%2fetc%2fpasswd")),
            "passwd"
        );
        for empty in [
            "https://example.com/",
            "https://example.com",
            "https://example.com/a/",
        ] {
            let n = download_name_for(&u(empty));
            assert!(!n.is_empty(), "{empty}");
            assert!(!n.contains('/'), "{empty} -> {n}");
        }
    }

    #[test]
    fn the_quarantine_directory_is_machine_state_and_not_a_project() {
        let root = quarantine_root();
        assert!(root.starts_with(storage::state_dir()));
        assert!(root.ends_with("quarantine"));
        assert!(browser_dir().ends_with("browser"));
    }

    #[test]
    fn sweeping_leaves_an_empty_private_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("quarantine");
        std::fs::create_dir_all(root.join("old-download")).unwrap();
        std::fs::write(root.join("old-download").join("x.bin"), b"stale").unwrap();
        sweep_quarantine_at(&root).unwrap();
        assert!(root.is_dir());
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&root).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o700, "quarantine must be owner-only");
        }
    }

    #[cfg(unix)]
    #[test]
    fn hardening_a_staged_file_removes_every_execute_bit() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("installer");
        std::fs::write(&f, b"#!/bin/sh\necho hi\n").unwrap();
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o755)).unwrap();
        harden_staged_file(&f).unwrap();
        let mode = std::fs::metadata(&f).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        assert_eq!(mode & 0o111, 0, "no execute bit may survive");
    }

    // ── Classification ──────────────────────────────────────────────────────

    #[test]
    fn executable_content_is_flagged_whatever_it_is_called() {
        for (magic, label) in [
            (&b"MZ\x90\x00"[..], "PE"),
            (&b"\x7fELF\x02\x01"[..], "ELF"),
            (&b"#!/bin/sh\n"[..], "shebang"),
            (&[0xCF, 0xFA, 0xED, 0xFE][..], "Mach-O"),
        ] {
            assert_eq!(
                classify(magic, "holiday-photos.jpg"),
                Classification::IsAProgram,
                "{label} must be flagged even when named .jpg"
            );
        }
    }

    #[test]
    fn a_double_extension_program_is_flagged_on_its_name_alone() {
        assert_eq!(
            classify(b"harmless bytes", "invoice.pdf.exe"),
            Classification::IsAProgram
        );
        assert_eq!(
            classify(b"harmless", "setup.msi"),
            Classification::IsAProgram
        );
        assert_eq!(classify(b"harmless", "run.sh"), Classification::IsAProgram);
    }

    #[test]
    fn a_type_mismatch_is_reported_but_a_plain_document_is_not() {
        // A PDF name over ZIP bytes.
        let zip = b"PK\x03\x04\x14\x00\x00\x00\x08\x00";
        assert_eq!(classify(zip, "report.pdf"), Classification::TypeMismatch);
        // A PDF name over PDF bytes.
        assert_eq!(classify(b"%PDF-1.7\n", "report.pdf"), Classification::Ok);
        // `infer` knows no text formats; a plain `.txt` must not read as a
        // mismatch just because nothing sniffed.
        assert_eq!(classify(b"hello world", "notes.txt"), Classification::Ok);
        assert_eq!(classify(b"", "notes.txt"), Classification::Ok);
    }

    #[test]
    fn classification_never_panics_on_short_or_empty_input() {
        for head in [&b""[..], b"M", b"#", b"\x7f", b"PK"] {
            let _ = classify(head, "x");
            let _ = classify(head, "");
            let _ = sniffs_as_executable(head);
        }
    }

    // ── Labels ──────────────────────────────────────────────────────────────

    #[test]
    fn live_labels_are_validated_and_carry_the_capability_prefix() {
        assert!(valid_live_label("browser-0"));
        assert!(valid_live_label("browser-a1_b-2"));
        assert!(!valid_live_label("browser-"));
        assert!(!valid_live_label("main"));
        assert!(!valid_live_label("present-x"));
        assert!(!valid_live_label("detached-x"));
        assert!(!valid_live_label("browser-../../etc"));
        assert!(!valid_live_label("browser-x?y=1"));
        assert!(!valid_live_label(&format!("browser-{}", "x".repeat(80))));
        assert!(valid_live_label(&next_live_label()));
    }

    // ── The live window's navigation policy ─────────────────────────────────

    fn rec(on: &str) -> LiveRecord {
        let url = u(on);
        let mut approved = HashSet::new();
        if let Some(h) = url.host_str() {
            approved.insert(h.to_string());
        }
        LiveRecord {
            label: "browser-0".into(),
            url,
            title: String::new(),
            approved_hosts: approved,
        }
    }

    #[test]
    fn a_live_window_may_not_navigate_to_the_app_origin() {
        let r = rec("https://example.com/");
        assert_eq!(
            live_navigation_allowed(&r, &u("http://localhost:1420/")),
            Err("app-origin".into())
        );
        assert_eq!(
            live_navigation_allowed(&r, &u("file:///etc/passwd")),
            Err("scheme:file".into())
        );
    }

    /// The compensating control for having no sub-resource filter: a page may
    /// not *navigate* to a private address it was not opened on, so it cannot
    /// turn itself into a local origin. It can still `fetch()` one — that gap is
    /// disclosed in this module's header and is not fixable from app code.
    #[test]
    fn a_page_cannot_walk_itself_onto_a_private_address() {
        let r = rec("https://example.com/");
        assert_eq!(
            live_navigation_allowed(&r, &u("http://192.168.1.1/")),
            Err("private-network".into())
        );
        assert_eq!(
            live_navigation_allowed(&r, &u("http://169.254.169.254/latest/meta-data/")),
            Err("link-local".into())
        );
        assert_eq!(
            live_navigation_allowed(&r, &u("http://127.0.0.1:11434/")),
            Err("loopback".into())
        );
    }

    /// …but a window the user deliberately opened *on* a dev server keeps
    /// working, including its own internal links.
    #[test]
    fn a_window_opened_on_a_private_host_may_browse_that_host() {
        let r = rec("http://127.0.0.1:3000/");
        assert!(live_navigation_allowed(&r, &u("http://127.0.0.1:3000/docs")).is_ok());
        assert!(live_navigation_allowed(&r, &u("http://127.0.0.1:8080/other")).is_ok());
        // A different private host is still a new decision.
        assert_eq!(
            live_navigation_allowed(&r, &u("http://192.168.1.1/")),
            Err("private-network".into())
        );
    }

    #[test]
    fn a_live_window_may_not_be_walked_from_https_down_to_http() {
        let r = rec("https://example.com/a");
        assert_eq!(
            live_navigation_allowed(&r, &u("http://example.com/b")),
            Err("downgrade".into())
        );
    }

    // ── Reader hops ─────────────────────────────────────────────────────────

    /// A markdown image URL is the document's choice, not the user's: even hop
    /// 0 may not reach this machine or its network, and only https passes.
    #[test]
    fn a_document_image_is_judged_like_a_server_chosen_hop() {
        let doc = FetchOrigin::Document;
        assert!(hop_allowed(&u("https://img.shields.io/badge/x.svg"), None, 0, doc).is_ok());
        assert_eq!(
            hop_allowed(&u("https://127.0.0.1/x.png"), None, 0, doc),
            Err("loopback".into())
        );
        assert_eq!(
            hop_allowed(&u("https://169.254.169.254/x.png"), None, 0, doc),
            Err("link-local".into())
        );
        assert_eq!(
            hop_allowed(&u("http://example.com/x.png"), None, 0, doc),
            Err("scheme:http".into())
        );
        assert_eq!(
            hop_allowed(&u("https://169.254.169.254/x.png"), Some(&u("https://example.com/")), 1, doc),
            Err("redirect-to-link-local".into())
        );
        // The user-typed reader path keeps its hop-0 allowance.
        assert!(hop_allowed(&u("http://127.0.0.1:3000/"), None, 0, FetchOrigin::User).is_ok());
    }

    #[test]
    fn a_document_image_must_arrive_as_an_image_type() {
        assert_eq!(
            document_image_mime("image/svg+xml; charset=utf-8"),
            Some("image/svg+xml")
        );
        assert_eq!(document_image_mime("IMAGE/PNG"), Some("image/png"));
        assert_eq!(document_image_mime("text/html"), None);
        assert_eq!(document_image_mime(""), None);
    }

    /// Hop 0 is the user's choice; every later hop is the server's. That
    /// distinction is the entire SSRF defence for a backend fetch.
    #[test]
    fn a_redirect_may_not_steer_a_reader_fetch_into_the_private_network() {
        assert!(reader_hop_allowed(&u("http://127.0.0.1:3000/"), None, 0).is_ok());
        assert!(reader_hop_allowed(&u("http://192.168.1.5/"), None, 0).is_ok());
        assert_eq!(
            reader_hop_allowed(
                &u("http://169.254.169.254/latest/meta-data/"),
                Some(&u("https://example.com/")),
                1
            ),
            Err("redirect-to-link-local".into())
        );
        assert_eq!(
            reader_hop_allowed(&u("http://127.0.0.1/"), Some(&u("https://example.com/")), 1),
            Err("redirect-to-loopback".into())
        );
        assert_eq!(
            reader_hop_allowed(&u("http://10.0.0.5/"), Some(&u("https://example.com/")), 2),
            Err("redirect-to-private-network".into())
        );
    }

    #[test]
    fn a_reader_fetch_refuses_every_non_web_scheme_and_the_app_origin() {
        assert_eq!(
            reader_hop_allowed(&u("file:///etc/passwd"), None, 0),
            Err("scheme:file".into())
        );
        assert_eq!(
            reader_hop_allowed(&u("http://localhost:1420/"), None, 0),
            Err("app-origin".into())
        );
        assert_eq!(
            reader_hop_allowed(&u("http://ipc.localhost/"), None, 0),
            Err("app-origin".into())
        );
    }

    // Both operands are consts; pinning their *relation* is the test.
    #[allow(clippy::assertions_on_constants)]
    #[test]
    fn a_reader_chain_is_capped_far_below_the_browsers_own_limit() {
        assert!(MAX_READER_REDIRECTS < web_safety::MAX_REDIRECTS);
        assert_eq!(
            reader_hop_allowed(
                &u("https://example.com/"),
                Some(&u("https://example.com/")),
                MAX_READER_REDIRECTS + 1
            ),
            Err("redirect-loop".into())
        );
    }

    // ── Decoding / titles ───────────────────────────────────────────────────

    #[test]
    fn the_charset_comes_from_the_header_then_the_meta_then_utf8() {
        // Windows-1252 `é` is a single 0xE9 byte, which is not valid UTF-8.
        let latin = b"<p>caf\xe9</p>";
        assert!(decode_body(latin, "text/html; charset=windows-1252").contains("café"));
        let meta = b"<meta charset=\"windows-1252\"><p>caf\xe9</p>";
        assert!(decode_body(meta, "text/html").contains("café"));
        assert_eq!(decode_body(b"<p>ok</p>", "text/html"), "<p>ok</p>");
    }

    #[test]
    fn a_title_is_read_before_sanitizing_and_stripped_of_format_controls() {
        assert_eq!(
            extract_title("<html><head><title>Hello &amp; welcome</title>"),
            "Hello & welcome"
        );
        let hostile = "<title>example.com \u{202E} Secure</title>";
        let t = extract_title(hostile);
        assert!(!t.contains('\u{202E}'), "{t}");
        // No title, an unterminated title, and an empty document are all fine.
        assert_eq!(extract_title("<html><body>x"), "");
        assert_eq!(extract_title(""), "");
        assert!(extract_title("<title>unterminated").len() <= MAX_TITLE_CHARS);
        assert!(
            extract_title(&format!("<title>{}</title>", "x".repeat(9999)))
                .chars()
                .count()
                <= MAX_TITLE_CHARS
        );
    }

    #[test]
    fn only_document_content_types_are_readable() {
        assert_eq!(
            readable_content_type("text/html; charset=utf-8"),
            Some(true)
        );
        assert_eq!(readable_content_type("TEXT/HTML"), Some(true));
        assert_eq!(readable_content_type("text/plain"), Some(false));
        assert_eq!(readable_content_type("application/pdf"), None);
        assert_eq!(readable_content_type("application/octet-stream"), None);
        assert_eq!(readable_content_type("image/png"), None);
    }

    /// `rustls-no-provider` means the client takes the process default, and
    /// rustls PANICS (not errors) when none is installed. Without this test the
    /// first sign of that would be a crash on a user's machine the first time
    /// they opened a reader tab.
    #[test]
    fn the_reader_client_builds_with_a_crypto_provider_installed() {
        assert!(reader_client(None).is_ok());
        // Twice, because the install is idempotent and a second reader tab must
        // not be the thing that panics.
        assert!(reader_client(None).is_ok());
        // And with a pin, which is the shape every real fetch uses.
        let pin = (
            "example.com".to_string(),
            vec![SocketAddr::from(([203, 0, 113, 10], 443))],
        );
        assert!(reader_client(Some(&pin)).is_ok());
    }

    /// The address half of disclosed gap (c). These are the judgements
    /// `resolve_hop` makes on whatever the resolver hands back — the part
    /// `reader_hop_allowed` structurally cannot make, since it never resolves.
    ///
    /// No DNS is performed here: resolution is the network's job and a test that
    /// needed it would be a test that fails on a train. What is pinned is the
    /// decision *given* an address, which is the part that was missing.
    #[test]
    fn a_resolved_address_inside_the_machine_is_not_globally_routable() {
        use std::net::{Ipv4Addr, Ipv6Addr};

        // Every spelling of "this machine" a resolver can produce.
        for ip in [
            IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)),
            IpAddr::V4(Ipv4Addr::new(127, 9, 9, 9)),
            IpAddr::V6(Ipv6Addr::LOCALHOST),
            // The one that defeats a naive check: IPv4-mapped IPv6.
            IpAddr::V6("::ffff:127.0.0.1".parse::<Ipv6Addr>().unwrap()),
        ] {
            assert!(!address_is_global(ip), "{ip} must not be treated as public");
            assert_eq!(reach_reason(ip), ConfirmReason::Loopback, "{ip}");
        }

        // The cloud metadata address, which is the whole point of the rule.
        let meta = IpAddr::V4(Ipv4Addr::new(169, 254, 169, 254));
        assert!(!address_is_global(meta));
        assert_eq!(reach_reason(meta), ConfirmReason::LinkLocal);
        assert_eq!(
            format!("redirect-to-{}", reach_reason(meta).token()),
            "redirect-to-link-local",
            "the message must stay inside the vocabulary the frontend translates"
        );

        // Private networks — including the one an OpenVPN tunnel typically joins.
        for ip in [
            IpAddr::V4(Ipv4Addr::new(10, 0, 0, 5)),
            IpAddr::V4(Ipv4Addr::new(172, 16, 0, 1)),
            IpAddr::V4(Ipv4Addr::new(192, 168, 1, 1)),
            IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1)),
            IpAddr::V6("fd00::1".parse::<Ipv6Addr>().unwrap()),
        ] {
            assert!(!address_is_global(ip), "{ip} must not be treated as public");
        }

        // Positive control: the rule must not swallow the public internet.
        for ip in [
            IpAddr::V4(Ipv4Addr::new(203, 0, 113, 10)),
            IpAddr::V6("2001:db8::1".parse::<Ipv6Addr>().unwrap()),
        ] {
            assert!(
                address_is_global(ip),
                "{ip} is public and must stay reachable"
            );
        }
    }

    #[test]
    fn a_transport_error_does_not_echo_the_url_back_into_the_ui() {
        let msg = tidy_transport_error(
            "error sending request for url (https://evil.example/\u{202E}x): connection refused",
        );
        assert!(!msg.contains("evil.example"), "{msg}");
        assert!(!msg.contains('\u{202E}'), "{msg}");
        assert!(msg.contains("connection refused"), "{msg}");
    }

    // ── The security readout ────────────────────────────────────────────────

    #[test]
    fn the_security_readout_shows_both_host_forms_and_never_the_userinfo() {
        let s = security_for(&u("https://xn--80ak6aa92e.example/x"), TlsState::Secure);
        assert_eq!(
            s.punycode_warning.as_deref(),
            Some("xn--80ak6aa92e.example")
        );
        assert_eq!(s.scheme, "https");
        let s = security_for(&u("https://example.com@evil.example/"), TlsState::Secure);
        assert_eq!(s.host_display, "evil.example");
        assert_eq!(s.punycode_warning, None);
    }
}

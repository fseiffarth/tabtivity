//! Shared web-safety primitives: URL policy, host display, and the one
//! filename sanitizer.
//!
//! Two features eat attacker-controlled URLs and attacker-controlled filenames:
//! the mail client (a message chooses both) and the in-app browser (a page
//! chooses both). They had to agree, so this module is where they agree —
//! `services::mail_sanitize` re-exports what it used to own, so mail's call
//! sites and its whole existing test table are untouched, and
//! `services::browser_engine` calls the same functions rather than a second
//! implementation that drifts.
//!
//! Three things live here:
//!
//! 1. **[`sanitize_attachment_name`]** — moved verbatim from `mail_sanitize`.
//!    Downloads and attachments are the same problem: a name from the network
//!    that ends up in a save dialog.
//! 2. **Host/scheme primitives** (`scheme_of`, `host_of`, `idna_display`,
//!    `registrable`, `has_userinfo`) — moved verbatim, still string-based
//!    because a mail `href` is not always a parseable URL.
//! 3. **The navigation gate** ([`navigation_decision`]) — new, and the one
//!    place a browser URL is judged. It takes an already-parsed [`Url`], never
//!    a `&str`, so there is no second parser to disagree with the first: the
//!    entire `https://example.com@evil.example/` class exists because a display
//!    layer re-derived the host by string search.
//!
//! **The gate runs in Rust, in the backend.** Not in an address-bar component:
//! a page navigates itself, a redirect moves it, and neither passes through
//! React.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::str::FromStr;

use ipnet::{Ipv4Net, Ipv6Net};
use url::{Host, Url};

// ─────────────────────────────────────────────────────────────────────────────
// Download marking (Mark-of-the-Web / quarantine)
// ─────────────────────────────────────────────────────────────────────────────

/// Mark a file that came from the network — a saved mail attachment, a browser
/// download — the way the OS expects, so its own protections apply: Windows
/// SmartScreen / Office Protected View read the `Zone.Identifier` stream,
/// macOS Gatekeeper reads the `com.apple.quarantine` extended attribute. Other
/// platforms have no such mark and this is a no-op.
///
/// **Best-effort and never fatal**: the file is already saved when this runs,
/// and a filesystem that cannot carry the mark (FAT/exFAT, some SMB shares) must
/// not turn a successful save into an error. **An existing mark is kept**: the
/// web engine may already have written one with better provenance, and this is
/// a floor, not an override.
///
/// Takes no URL on purpose: the recorded origin is always the generic
/// `about:internet`, matching the browser's ephemeral-profile posture — the page
/// a file came from is not something to write beside it on disk.
pub fn mark_downloaded(path: &std::path::Path) {
    #[cfg(target_os = "windows")]
    {
        use std::io::Write;
        let stream = format!("{}:Zone.Identifier", path.display());
        if std::fs::metadata(&stream).is_ok() {
            return;
        }
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&stream)
        {
            let _ = f.write_all(zone_identifier_body(Some("about:internet")).as_bytes());
        }
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::ffi::OsStrExt;
        let Ok(c_path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
            return;
        };
        let name = c"com.apple.quarantine";
        // SAFETY: both strings are NUL-terminated and outlive the calls; a null
        // buffer with size 0 only asks whether the attribute exists.
        let existing = unsafe {
            libc::getxattr(c_path.as_ptr(), name.as_ptr(), std::ptr::null_mut(), 0, 0, 0)
        };
        if existing >= 0 {
            return;
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let value = quarantine_xattr_value(now, crate::brand::DISPLAY);
        // SAFETY: `value` is a live byte buffer of exactly `value.len()` bytes.
        unsafe {
            libc::setxattr(
                c_path.as_ptr(),
                name.as_ptr(),
                value.as_ptr().cast(),
                value.len(),
                0,
                0,
            );
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = path;
    }
}

/// The `:Zone.Identifier` stream body Windows writes for a download from the
/// Internet zone (`ZoneId=3`). CRLF line endings, as Windows writes them. A host
/// URL carrying a line break is dropped rather than written, so nothing can
/// inject a second `ZoneId` line.
#[cfg(any(target_os = "windows", test))]
pub(crate) fn zone_identifier_body(host_url: Option<&str>) -> String {
    let mut body = String::from("[ZoneTransfer]\r\nZoneId=3\r\n");
    if let Some(url) = host_url.filter(|u| !u.is_empty() && !u.contains(['\r', '\n'])) {
        body.push_str("HostUrl=");
        body.push_str(url);
        body.push_str("\r\n");
    }
    body
}

/// The `com.apple.quarantine` value: `flags;hex epoch seconds;agent;`. `0081`
/// is the "downloaded by an application" shape browsers write; the agent name
/// has `;` removed since it is the field separator.
#[cfg(any(target_os = "macos", test))]
pub(crate) fn quarantine_xattr_value(epoch_secs: u64, agent: &str) -> String {
    let agent: String = agent.chars().filter(|c| *c != ';' && !c.is_control()).collect();
    format!("0081;{epoch_secs:08x};{agent};")
}

// ─────────────────────────────────────────────────────────────────────────────
// Format controls
// ─────────────────────────────────────────────────────────────────────────────

/// Bidi and invisible formatting characters. `invoice\u{202E}gnp.exe` renders as
/// `invoicexe.png` in every UI that does not strip these — the single most
/// effective filename disguise there is, and the same trick works on a page
/// title (`example.com — Secure  \u{2069}`).
///
/// This list is mirrored in `src/lib/textSafety.ts`, which spells it as
/// character *ranges*. That difference is why `src/__tests__/security/TextSafety.test.ts`
/// reads this array out of this file and compares both directions: the
/// invisible-math block `U+2061`–`U+2064` was in the range on the TS side and
/// absent here, so the same string came back cleaned or not depending on which
/// side of the IPC boundary had touched it last. Add to both, or to neither.
pub const FORMAT_CHARS: &[char] = &[
    '\u{200E}', '\u{200F}', '\u{202A}', '\u{202B}', '\u{202C}', '\u{202D}', '\u{202E}', '\u{2066}',
    '\u{2067}', '\u{2068}', '\u{2069}', '\u{061C}', '\u{00AD}', '\u{FEFF}', '\u{200B}', '\u{200C}',
    '\u{200D}', '\u{2060}', '\u{2061}', '\u{2062}', '\u{2063}', '\u{2064}', '\u{180E}',
];

pub fn is_format_char(c: char) -> bool {
    FORMAT_CHARS.contains(&c)
}

/// Strip bidi/format controls and C0/C1 controls from a string that will be
/// rendered as a label (a page title, a tab title, a download name).
pub fn strip_format_controls(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_control() && !is_format_char(*c))
        .collect()
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheme / host primitives (string-based; moved from `mail_sanitize`)
// ─────────────────────────────────────────────────────────────────────────────

/// Web schemes a mail link may carry without a warning chip.
pub const WEB_SCHEMES: &[&str] = &["http", "https", "mailto"];

pub fn scheme_of(url: &str) -> String {
    let trimmed = url.trim_start_matches(|c: char| c.is_whitespace() || is_format_char(c));
    match trimmed.find(':') {
        Some(i)
            if i > 0
                && trimmed[..i]
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'-' || b == b'.') =>
        {
            trimmed[..i].to_ascii_lowercase()
        }
        _ => String::new(),
    }
}

pub fn has_userinfo(url: &str) -> bool {
    if let Some(parsed) = parse_special(url) {
        return !parsed.username().is_empty() || parsed.password().is_some();
    }
    let Some(rest) = after_authority_marker(url) else {
        return false;
    };
    let authority = rest.split(['/', '\\', '?', '#']).next().unwrap_or_default();
    authority.contains('@')
}

/// An http(s) URL parsed the way a browser will parse it, or `None`.
///
/// The WHATWG parser is the ground truth for where such a link *goes*, and a
/// hand-rolled split disagrees with it exactly where phishing lives: a browser
/// reads `\` as `/` in these schemes, so `https://evil.example\@bank.example/`
/// is a request to evil.example that a split on `/?#` labels "bank.example".
fn parse_special(url: &str) -> Option<url::Url> {
    let scheme = scheme_of(url);
    if scheme != "http" && scheme != "https" {
        return None;
    }
    url::Url::parse(url.trim()).ok()
}

fn after_authority_marker(url: &str) -> Option<&str> {
    let idx = url.find("//")?;
    Some(&url[idx + 2..])
}

pub fn host_of(url: &str) -> String {
    let scheme = scheme_of(url);
    if scheme == "mailto" {
        let rest = url.split_once(':').map(|x| x.1).unwrap_or_default();
        return rest
            .rsplit('@')
            .next()
            .unwrap_or_default()
            .split(['?', '#'])
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
    }
    if let Some(parsed) = parse_special(url) {
        return parsed
            .host_str()
            .unwrap_or_default()
            .trim_matches(['[', ']'])
            .to_ascii_lowercase();
    }
    let Some(rest) = after_authority_marker(url) else {
        return String::new();
    };
    let authority = rest.split(['/', '\\', '?', '#']).next().unwrap_or_default();
    let host = authority.rsplit('@').next().unwrap_or_default();
    let host = host.split(':').next().unwrap_or_default();
    host.trim_matches(['[', ']']).to_ascii_lowercase()
}

/// Punycode → Unicode for display, keeping the ASCII form when the conversion
/// is not round-trip safe. Callers show **both** forms; this is only the
/// friendly one.
pub fn idna_display(host: &str) -> String {
    match idna::domain_to_unicode(host) {
        (unicode, Ok(())) => unicode,
        _ => host.to_string(),
    }
}

/// The registrable-ish suffix of a host: the last two labels. A real public
/// suffix list is a Phase-2 refinement; two labels already catches the case
/// that matters (`bank.example` vs `evil.example`) without shipping a PSL.
///
/// Deliberately **not** upgraded to the `psl` crate here: doing so would change
/// `mail_sanitize::link_info`'s mismatch decisions, which are cached under
/// `SANITIZER_VERSION`, and that is a mail change wearing a browser change's
/// clothes. It is the one shared primitive whose refinement has to be its own
/// commit with its own version bump.
pub fn registrable(host: &str) -> String {
    let labels: Vec<&str> = host.split('.').filter(|l| !l.is_empty()).collect();
    if labels.len() <= 2 {
        return labels.join(".");
    }
    labels[labels.len() - 2..].join(".")
}

/// Every hostname an anchor's visible text claims, in order.
///
/// **Every** word, not the first: "Sign in to paypal.com" names a host as its
/// fourth word, and a check that stopped at "Sign" let that text point anywhere
/// without a flag. Surrounding punctuation is peeled first so "(paypal.com)" and
/// "paypal.com." still count.
pub fn hosts_in_text(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for word in text.split_whitespace() {
        let word = word.trim_matches(|c: char| {
            matches!(c, '(' | ')' | '[' | ']' | '<' | '>' | '"' | '\'' | ',' | ';' | ':' | '!' | '?')
        });
        if word.contains("://") {
            let h = host_of(word);
            if !h.is_empty() {
                out.push(h);
            }
            continue;
        }
        let Some(candidate) = word.split(['/', '\\', '?', '#']).next() else {
            continue;
        };
        let candidate = candidate.trim_end_matches('.').to_ascii_lowercase();
        if candidate.contains('.')
            && candidate.split('.').filter(|l| !l.is_empty()).count() >= 2
            && candidate
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
            && looks_like_host_suffix(&candidate)
        {
            out.push(candidate);
        }
    }
    out
}

/// Whether a dotted word ends the way a hostname does — so scanning every word
/// of a link's text does not read "e.g.", "3.14" or "report.pdf" as a site the
/// text names, which would put a phishing flag on ordinary links.
fn looks_like_host_suffix(candidate: &str) -> bool {
    /// File extensions that are not TLDs anyone links to. `.zip` and `.mov`
    /// are left out on purpose: they *are* TLDs, and phishing uses both.
    const FILE_EXTENSIONS: &[&str] = &[
        "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv", "png", "jpg", "jpeg",
        "gif", "svg", "htm", "html", "php", "asp", "aspx", "jsp", "exe", "tar", "gz", "ics", "eml",
    ];
    let labels: Vec<&str> = candidate.split('.').collect();
    if labels.iter().any(|l| l.is_empty()) {
        return false;
    }
    // A dotted-quad IPv4 address is a host.
    if labels.len() == 4 && labels.iter().all(|l| l.len() <= 3 && l.bytes().all(|b| b.is_ascii_digit())) {
        return true;
    }
    let tld = labels.last().copied().unwrap_or_default();
    (tld.starts_with("xn--") || (tld.len() >= 2 && tld.bytes().all(|b| b.is_ascii_alphabetic())))
        && !FILE_EXTENSIONS.contains(&tld)
}

/// The first hostname an anchor's visible text claims, if it claims one.
pub fn host_in_text(text: &str) -> Option<String> {
    hosts_in_text(text).into_iter().next()
}

// ─────────────────────────────────────────────────────────────────────────────
// Filenames (moved from `mail_sanitize`)
// ─────────────────────────────────────────────────────────────────────────────

/// The result of [`sanitize_attachment_name`]. `changed` drives the UI's
/// "renamed for safety" marker: a user who cannot *see* that a name was altered
/// cannot notice that it was hostile, so a rename is never silent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SafeName {
    pub value: String,
    pub changed: bool,
    pub reason: Option<&'static str>,
}

/// Windows device names. `CON.txt` is still the device, so the match is on the
/// stem before the first dot.
pub const RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "COM¹", "COM²", "COM³", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8",
    "LPT9", "CONIN$", "CONOUT$",
];

/// Longest filename we hand to a save dialog. Filesystem limits are 255 bytes;
/// 200 leaves room for the OS dialog's own `(1)` disambiguation.
pub const MAX_NAME_BYTES: usize = 200;

/// Make a network-supplied filename safe for every position it is used in — the
/// save-dialog default, the UI label, the outgoing `Content-Disposition`.
///
/// Note what this function is *not* load-bearing for: the mail store never uses
/// the supplied name at all (blobs are content-addressed), the browser's
/// quarantine path is minted by us, and in both features the save destination is
/// chosen by the OS dialog rather than by the name. Path traversal therefore has
/// to defeat three independent things, of which this is one.
///
/// Rules run in order; the order matters (decoding before stripping is the
/// classic `%2e%2e%2f` bypass, so callers must pass the **already decoded**
/// name).
pub fn sanitize_attachment_name(input: &str) -> SafeName {
    let original = input;
    let mut reason: Option<&'static str> = None;

    // 2. Normalize to NFC so a decomposed sequence cannot render as one thing
    //    and compare as another. `idna`'s UTS-46 mapping is the NFC pass we
    //    already have in the tree; for a filename we do the cheap equivalent by
    //    working on chars directly (Rust std has no NFC), and instead reject the
    //    characters that make the distinction exploitable below.
    // 3. Last path component, splitting on BOTH separators — a Unix host must
    //    still defend against `..\..\`.
    let mut name: String = original
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .to_string();
    if name != original {
        reason = Some("path-component");
    }
    // Windows drive / alternate-data-stream segments (`C:`, `file.txt:zone`).
    if let Some((head, _tail)) = name.split_once(':') {
        if name.contains(':') {
            name = head.to_string();
            reason = reason.or(Some("stream-suffix"));
        }
    }

    // 4./5. Controls, bidi and invisible formatting.
    let cleaned: String = name
        .chars()
        .filter(|c| !c.is_control() && !is_format_char(*c))
        .collect();
    if cleaned != name {
        reason = reason.or(Some("control-chars"));
    }
    name = cleaned;

    // 6. Windows-illegal characters.
    let replaced: String = name
        .chars()
        .map(|c| if "<>:\"|?*".contains(c) { '_' } else { c })
        .collect();
    if replaced != name {
        reason = reason.or(Some("illegal-chars"));
    }
    name = replaced;

    // 11. Collapse whitespace runs, trim.
    name = name.split_whitespace().collect::<Vec<_>>().join(" ");

    // 8. Trailing dots and spaces — Windows strips them silently, so
    //    `evil.exe. ` and `evil.exe` are one file to the OS but two to a naive
    //    extension check.
    let trimmed = name.trim_end_matches(['.', ' ']).to_string();
    if trimmed != name {
        reason = reason.or(Some("trailing-dots"));
    }
    name = trimmed;

    // 3 (cont.) / 12. `.`, `..` and empty become a fixed name.
    if name.is_empty() || name == "." || name == ".." {
        return SafeName {
            value: "attachment".to_string(),
            changed: true,
            reason: reason.or(Some("empty")),
        };
    }

    // 7. Windows reserved device names.
    let stem = name.split('.').next().unwrap_or("").trim_end();
    if RESERVED_NAMES
        .iter()
        .any(|r| r.eq_ignore_ascii_case(stem.trim()))
    {
        name = format!("_{name}");
        reason = reason.or(Some("reserved-name"));
    }

    // 9. A leading `-` becomes an argv flag to any tool the user later runs on
    //    the saved file.
    // 10. A leading `.` is a silently-hidden file.
    if name.starts_with('-') || name.starts_with('.') {
        name = format!("_{name}");
        reason = reason.or(Some("leading-char"));
    }

    // 13. Truncate to 200 bytes on a char boundary, preserving the extension.
    if name.len() > MAX_NAME_BYTES {
        name = truncate_keeping_extension(&name);
        reason = reason.or(Some("too-long"));
    }

    let changed = name != original;
    SafeName {
        value: name,
        changed,
        reason: if changed {
            reason.or(Some("normalized"))
        } else {
            None
        },
    }
}

fn truncate_keeping_extension(name: &str) -> String {
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 && name.len() - i <= 17 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let budget = MAX_NAME_BYTES.saturating_sub(ext.len());
    let mut cut = budget.min(stem.len());
    while cut > 0 && !stem.is_char_boundary(cut) {
        cut -= 1;
    }
    let out = format!("{}{}", &stem[..cut], ext);
    if out.is_empty() {
        "attachment".to_string()
    } else {
        out
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// The navigation gate
// ─────────────────────────────────────────────────────────────────────────────

/// What the gate decided about one URL.
///
/// Three states, not two, and the third is the interesting one: an address on
/// the machine or on the local network is not *wrong* to visit — a developer's
/// own dev server is the obvious case — but it is the one place this browser is
/// genuinely more dangerous than a normal one, because Tabtivity may be holding a
/// VPN tunnel into a network the user's real browser cannot see.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NavDecision {
    Allow,
    /// Reachable, but only after the user says so for this specific host.
    Confirm(ConfirmReason),
    Block(BlockReason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfirmReason {
    /// `127.0.0.1`, `::1`, `localhost` — this computer.
    Loopback,
    /// RFC 1918 / ULA / CGNAT — the network this machine (or its tunnel) is on.
    PrivateNetwork,
    /// `169.254.0.0/16`, `fe80::/10` — including the cloud metadata address.
    LinkLocal,
    /// `.local`, `.internal`, `.home.arpa` and friends.
    InternalName,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlockReason {
    /// Not a URL at all.
    Unparsable,
    /// A scheme outside the allowlist. Carries the scheme, lowercased.
    Scheme(String),
    /// `about:` something other than `blank`/`srcdoc`.
    AboutInternal,
    /// Tabtivity's own frontend origin — `tauri://`, the packaged app URL, or the
    /// dev server. See the module note on `is_local_url`.
    AppOrigin,
    /// An `https:` page navigating itself to `http:` on the same host.
    Downgrade,
    /// More hops than [`MAX_REDIRECTS`].
    RedirectLoop,
    /// A host the URL parser accepted but that names nothing routable.
    NoHost,
}

impl BlockReason {
    /// A stable, machine-readable token for the frontend. Not a sentence — the
    /// wording lives in `src/lib/i18n.ts`, which is the frontend's to own.
    pub fn token(&self) -> String {
        match self {
            BlockReason::Unparsable => "unparsable".into(),
            BlockReason::Scheme(s) => format!("scheme:{s}"),
            BlockReason::AboutInternal => "about-internal".into(),
            BlockReason::AppOrigin => "app-origin".into(),
            BlockReason::Downgrade => "downgrade".into(),
            BlockReason::RedirectLoop => "redirect-loop".into(),
            BlockReason::NoHost => "no-host".into(),
        }
    }
}

impl ConfirmReason {
    pub fn token(&self) -> &'static str {
        match self {
            ConfirmReason::Loopback => "loopback",
            ConfirmReason::PrivateNetwork => "private-network",
            ConfirmReason::LinkLocal => "link-local",
            ConfirmReason::InternalName => "internal-name",
        }
    }
}

/// **The canonical list of every reason token the browser can put in front of a
/// user**, and the reason this list exists as data rather than as a comment.
///
/// The tokens are deliberately machine-readable — `app-origin`, `scheme:file`,
/// `redirect-to-link-local` — because the *wording* is the frontend's, in
/// `src/lib/i18n.ts`, in five languages. That split is only safe if the two
/// halves cannot drift: a token the frontend has no phrase for renders as the
/// raw token, which is how `redirect-to-link-local` ends up on a user's screen.
///
/// So this array is the contract. `reason_tokens_are_exhaustive` below fails if
/// a `BlockReason`/`ConfirmReason` variant is added without listing it here, and
/// `src/__tests__/browser/BrowserTripwire.test.ts` reads this very array out of this
/// file and fails if any entry has no i18n phrase. Neither side can move alone.
///
/// `scheme:` is listed as a **prefix**: the gate appends the offending scheme
/// (`scheme:file`, `scheme:javascript`), so the frontend matches on the prefix
/// and interpolates the rest.
pub const REASON_TOKENS: &[&str] = &[
    // BlockReason
    "unparsable",
    "scheme:",
    "about-internal",
    "app-origin",
    "downgrade",
    "redirect-loop",
    "no-host",
    // ConfirmReason
    "loopback",
    "private-network",
    "link-local",
    "internal-name",
    // A reader fetch's later hops: the *server* chose this address, so a
    // Confirm becomes a Block (`browser_engine::reader_hop_allowed`).
    "redirect-to-loopback",
    "redirect-to-private-network",
    "redirect-to-link-local",
    "redirect-to-internal-name",
    // Minted by `commands::browser`, not by the gate.
    "download-too-large",
];

/// Hop cap. WebKit and WebView2 both cap internally; this is ours so the
/// behaviour is identical on both and so the *count* is available to the UI.
pub const MAX_REDIRECTS: usize = 20;

/// The dev server's port, from `tauri.conf.json`'s `build.devUrl`.
///
/// This is BC-5 and it is the finding that is easiest to get wrong. Tauri's
/// `Webview::is_local_url` returns **true** for any URL relative to the app URL,
/// and in a `tauri dev` build the app URL *is* `http://localhost:1420`. A
/// browser that navigated there would be `Origin::Local` — i.e. it would clear
/// the origin half of the ACL gate. So the port is blocked in **both** profiles,
/// not behind `cfg(debug_assertions)`: a rule that only exists in the build
/// where it is hard to test is a rule nobody ever sees fail.
const DEV_SERVER_PORT: u16 = 1420;

/// Host suffixes that are Tabtivity's (or Tauri's) own origin on some platform.
/// On Windows every custom protocol Tauri registers is served from
/// `http://<name>.localhost`, and `is_local_url` treats all of them as local —
/// which is why the whole `*.localhost` space is refused rather than the two
/// names we happen to know about.
const LOCAL_PROTOCOL_SUFFIX: &str = ".localhost";

/// Schemes that reach a *local* origin, an OS handler, or the current
/// document's origin. None of them has a legitimate top-level use in a browser
/// tab, and several are historical RCE handlers.
const HARD_BLOCKED_SCHEMES: &[&str] = &[
    "file",
    "tauri",
    "asset",
    "ipc",
    "javascript",
    "data",
    "blob",
    "view-source",
    "jar",
    "ws",
    "wss",
    "ftp",
    "ftps",
    "sftp",
    "smb",
    "gopher",
    "vbscript",
    "chrome",
    "chrome-extension",
    "moz-extension",
    "resource",
    "search-ms",
    "ms-msdt",
    "ms-appinstaller",
    "intent",
    "android-app",
];

/// The whole allowlist. Anything not here is blocked, including a scheme
/// invented after this line was written.
const ALLOWED_SCHEMES: &[&str] = &["http", "https", "about"];

/// Context for one navigation decision.
#[derive(Debug, Clone, Default)]
pub struct NavContext {
    /// The URL the tab is currently on, when there is one. Only used for the
    /// same-host downgrade rule — a first-hop `http:` is usually just an old
    /// site, whereas an `https:` page steering itself onto `http:` is the shape
    /// of an active attacker.
    pub current: Option<Url>,
    /// How many hops this chain has already taken.
    pub redirects: usize,
}

/// **The** navigation gate. Pure, total, and never panics.
pub fn navigation_decision(url: &Url, ctx: &NavContext) -> NavDecision {
    if ctx.redirects > MAX_REDIRECTS {
        return NavDecision::Block(BlockReason::RedirectLoop);
    }

    let scheme = url.scheme().to_ascii_lowercase();

    if HARD_BLOCKED_SCHEMES.contains(&scheme.as_str()) {
        return NavDecision::Block(BlockReason::Scheme(scheme));
    }
    if !ALLOWED_SCHEMES.contains(&scheme.as_str()) {
        return NavDecision::Block(BlockReason::Scheme(scheme));
    }

    if scheme == "about" {
        // `about:blank` and `about:srcdoc` must be allowed or ordinary pages
        // break: wry's `decide-policy` handler fires for iframe navigations too,
        // so a page's own blank frame comes through this same gate.
        return match url.path() {
            "blank" | "srcdoc" => NavDecision::Allow,
            _ => NavDecision::Block(BlockReason::AboutInternal),
        };
    }

    let Some(host) = url.host() else {
        return NavDecision::Block(BlockReason::NoHost);
    };

    if is_app_origin(url, &host) {
        return NavDecision::Block(BlockReason::AppOrigin);
    }

    // A same-host https → http step. Cross-host is not a downgrade, it is a
    // different site, and blocking it would break half the web's redirects.
    if scheme == "http" {
        if let Some(prev) = &ctx.current {
            if prev.scheme() == "https" && prev.host() == Some(host.clone()) {
                return NavDecision::Block(BlockReason::Downgrade);
            }
        }
    }

    match host_reach(&host) {
        Reach::Global => NavDecision::Allow,
        Reach::Confirm(r) => NavDecision::Confirm(r),
    }
}

/// Parse-then-decide, for the many callers that hold a string. A string that
/// does not parse is a block, never a pass-through.
pub fn navigation_decision_str(raw: &str, ctx: &NavContext) -> (Option<Url>, NavDecision) {
    match Url::parse(raw) {
        Ok(u) => {
            let d = navigation_decision(&u, ctx);
            (Some(u), d)
        }
        Err(_) => (None, NavDecision::Block(BlockReason::Unparsable)),
    }
}

/// Tabtivity's own frontend origin, on every platform and in every build profile.
///
/// Two normalizations are load-bearing here and both were bugs before they were
/// written down, because each produces a name the *resolver* treats as the app
/// origin and this function did not:
///
/// 1. **The trailing root dot.** `Url` keeps it — `http://tauri.localhost./`
///    parses to the domain `tauri.localhost.` — so `ends_with(".localhost")` was
///    false for it and the URL fell through to [`host_reach`], which read it as
///    an ordinary globally-routable name and returned **Allow**. Not a confirm:
///    a plain allow, for a name every `*.localhost` resolver answers with
///    `127.0.0.1`. Same shape for `http://localhost.:1420/`.
/// 2. **The IPv4-mapped IPv6 form.** `Ipv6Addr::is_loopback` is true only for
///    `::1`, so `http://[::ffff:127.0.0.1]:1420/` was not recognized as the dev
///    server. [`host_reach`] already unmaps before classifying; this did not.
fn is_app_origin(url: &Url, host: &Host<&str>) -> bool {
    // `tauri://…` / `asset://…` / `ipc://…` never reach here (hard-blocked
    // above), so this is only about the http(s) spellings.
    if let Host::Domain(d) = host {
        // The root dot is part of the *same* name to every resolver.
        let d = d.trim_end_matches('.').to_ascii_lowercase();
        // Windows/Android serve the app and every registered custom protocol
        // from `<name>.localhost`. `tauri.localhost` is the app itself.
        if d.ends_with(LOCAL_PROTOCOL_SUFFIX) || d == "tauri.localhost" {
            return true;
        }
        if d == "localhost" && url.port() == Some(DEV_SERVER_PORT) {
            return true;
        }
        return false;
    }
    // `http://127.0.0.1:1420/` is the same dev server by another name.
    if url.port() == Some(DEV_SERVER_PORT) {
        if let Some(ip) = host_ip(host) {
            return unmap(ip).is_loopback();
        }
    }
    false
}

/// `::ffff:127.0.0.1` is `127.0.0.1`. Every place that asks a question about an
/// address has to unmap first, or the v6 spelling is a second answer.
fn unmap(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6
            .to_ipv4_mapped()
            .map(IpAddr::V4)
            .unwrap_or(IpAddr::V6(v6)),
        v4 => v4,
    }
}

enum Reach {
    Global,
    Confirm(ConfirmReason),
}

fn host_ip(host: &Host<&str>) -> Option<IpAddr> {
    match host {
        Host::Ipv4(v4) => Some(IpAddr::V4(*v4)),
        Host::Ipv6(v6) => Some(IpAddr::V6(*v6)),
        Host::Domain(_) => None,
    }
}

/// Internal-only name suffixes. A `.local` name is mDNS on the LAN; `.internal`
/// and `.home.arpa` are reserved for exactly this.
const INTERNAL_SUFFIXES: &[&str] = &[".local", ".internal", ".home.arpa", ".lan", ".intranet"];

fn host_reach(host: &Host<&str>) -> Reach {
    match host {
        Host::Domain(d) => {
            let d = d.trim_end_matches('.').to_ascii_lowercase();
            if d == "localhost" {
                return Reach::Confirm(ConfirmReason::Loopback);
            }
            if INTERNAL_SUFFIXES.iter().any(|s| d.ends_with(s))
                || ["local", "internal", "lan", "intranet"].contains(&d.as_str())
            {
                return Reach::Confirm(ConfirmReason::InternalName);
            }
            Reach::Global
        }
        Host::Ipv4(v4) => ipv4_reach(*v4),
        Host::Ipv6(v6) => {
            // `::ffff:127.0.0.1` is `127.0.0.1`. Classifying the v6 form
            // separately is how the mapped-address bypass gets written.
            if let Some(v4) = v6.to_ipv4_mapped() {
                return ipv4_reach(v4);
            }
            ipv6_reach(*v6)
        }
    }
}

fn net4(cidr: &str) -> Ipv4Net {
    Ipv4Net::from_str(cidr).expect("static CIDR")
}

fn net6(cidr: &str) -> Ipv6Net {
    Ipv6Net::from_str(cidr).expect("static CIDR")
}

fn ipv4_reach(a: Ipv4Addr) -> Reach {
    if a.is_loopback() || a.is_unspecified() {
        return Reach::Confirm(ConfirmReason::Loopback);
    }
    if a.is_link_local() {
        // Includes 169.254.169.254, the cloud metadata endpoint — the single
        // most valuable address an SSRF can reach.
        return Reach::Confirm(ConfirmReason::LinkLocal);
    }
    if a.is_private()
        // CGNAT. `Ipv4Addr::is_private()` does not cover it and
        // `is_global()` is still unstable, hence the explicit range.
        || net4("100.64.0.0/10").contains(&a)
        || net4("192.0.0.0/24").contains(&a)
        || a.is_broadcast()
        || a.is_multicast()
    {
        return Reach::Confirm(ConfirmReason::PrivateNetwork);
    }
    Reach::Global
}

fn ipv6_reach(a: Ipv6Addr) -> Reach {
    if a.is_loopback() || a.is_unspecified() {
        return Reach::Confirm(ConfirmReason::Loopback);
    }
    if net6("fe80::/10").contains(&a) {
        return Reach::Confirm(ConfirmReason::LinkLocal);
    }
    if net6("fc00::/7").contains(&a) || a.is_multicast() {
        return Reach::Confirm(ConfirmReason::PrivateNetwork);
    }
    Reach::Global
}

/// Whether a host is globally routable, i.e. the gate would not ask about it.
pub fn is_globally_routable(host: &Host<&str>) -> bool {
    matches!(host_reach(host), Reach::Global)
}

/// Whether this URL names *this machine*.
pub fn is_loopback_url(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(d)) => d.trim_end_matches('.').eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(v4)) => v4.is_loopback(),
        Some(Host::Ipv6(v6)) => {
            v6.is_loopback()
                || v6
                    .to_ipv4_mapped()
                    .map(|v| v.is_loopback())
                    .unwrap_or(false)
        }
        None => false,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Display
// ─────────────────────────────────────────────────────────────────────────────

/// How a URL is shown to a human.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UrlDisplay {
    /// The full URL, userinfo removed, host in its Unicode form. **Never
    /// truncated** — `https://example.com.evil.tld/…` elided to
    /// `https://example.com…` is the attack, not the fix.
    pub display: String,
    /// The host as shown (Unicode).
    pub host: String,
    /// The ASCII/punycode host, present **only** when it differs from the
    /// displayed one. Callers must render both: the Unicode form alone is the
    /// homograph attack, and the ASCII form alone is unreadable.
    pub punycode: Option<String>,
    /// The URL carried a `user:pass@` section. `https://example.com@evil.example/`
    /// is a link that tried to look like `example.com`.
    pub userinfo: bool,
}

/// Build the display form of a parsed URL.
pub fn describe_url(url: &Url) -> UrlDisplay {
    let userinfo = !url.username().is_empty() || url.password().is_some();
    let ascii_host = url.host_str().unwrap_or_default().to_string();
    let unicode_host = if ascii_host.is_empty() {
        String::new()
    } else {
        idna_display(&ascii_host)
    };
    let punycode = if !ascii_host.is_empty() && unicode_host != ascii_host {
        Some(ascii_host.clone())
    } else {
        None
    };

    // Rebuild rather than string-edit: stripping `user:pass@` with a `find('@')`
    // is precisely the parse-mismatch this whole module exists to avoid.
    let mut shown = url.clone();
    let _ = shown.set_username("");
    let _ = shown.set_password(None);
    let mut display = shown.to_string();
    if punycode.is_some() {
        // `Url::to_string` always emits the ASCII host; swap in the Unicode one
        // for display only.
        display = display.replacen(&ascii_host, &unicode_host, 1);
    }

    UrlDisplay {
        display: strip_format_controls(&display),
        host: if unicode_host.is_empty() {
            url.scheme().to_string()
        } else {
            unicode_host
        },
        punycode,
        userinfo,
    }
}

#[cfg(test)]
mod download_mark_tests {
    use super::*;

    #[test]
    fn zone_identifier_is_internet_zone_with_crlf() {
        assert_eq!(
            zone_identifier_body(Some("about:internet")),
            "[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=about:internet\r\n"
        );
        assert_eq!(zone_identifier_body(None), "[ZoneTransfer]\r\nZoneId=3\r\n");
    }

    #[test]
    fn zone_identifier_refuses_a_line_break_in_the_host_url() {
        let body = zone_identifier_body(Some("about:internet\r\nZoneId=0"));
        assert_eq!(body, "[ZoneTransfer]\r\nZoneId=3\r\n");
        assert_eq!(body.matches("ZoneId=").count(), 1);
    }

    #[test]
    fn quarantine_value_shape() {
        assert_eq!(quarantine_xattr_value(0x5f1e_2f3a, crate::brand::DISPLAY), concat!("0081;5f1e2f3a;", crate::app_name!(), ";"));
        assert_eq!(quarantine_xattr_value(1, "a;b\n"), "0081;00000001;ab;");
    }

    #[test]
    fn marking_is_best_effort_and_never_panics() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("x.bin");
        std::fs::write(&file, b"x").unwrap();
        mark_downloaded(&file);
        // A path that does not exist is silently ignored.
        mark_downloaded(&tmp.path().join("missing"));
        assert_eq!(std::fs::read(&file).unwrap(), b"x");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap_or_else(|e| panic!("parse {s}: {e}"))
    }

    fn decide(s: &str) -> NavDecision {
        navigation_decision_str(s, &NavContext::default()).1
    }

    fn blocked(s: &str) -> bool {
        matches!(decide(s), NavDecision::Block(_))
    }

    // ── Schemes ─────────────────────────────────────────────────────────────

    /// The whole point of an allowlist is that the list of things it refuses is
    /// not enumerable. These are the ones with history.
    #[test]
    fn the_scheme_allowlist_refuses_everything_else() {
        for case in [
            "file:///etc/passwd",
            "file://server/share/x",
            "tauri://localhost/",
            "asset://localhost/x",
            "ipc://localhost",
            "javascript:alert(1)",
            "JaVaScRiPt:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "blob:https://example.com/uuid",
            "ws://example.com/",
            "wss://example.com/",
            "ftp://example.com/",
            "smb://host/share",
            "gopher://example.com/",
            "vbscript:msgbox",
            "ms-msdt:/id",
            "search-ms:query=x",
            "chrome://settings",
            "moz-extension://x/y",
            "view-source:https://example.com/",
            "jar:https://example.com/a.jar!/b",
            "intent://x#Intent;end",
            concat!(crate::app_slug!(), "-nonsense://x"),
            "about:config",
            "about:cache",
        ] {
            assert!(blocked(case), "`{case}` must be blocked");
        }
    }

    #[test]
    fn the_web_and_two_about_urls_are_allowed() {
        for case in [
            "https://example.com/",
            "http://example.com/",
            "https://example.com/a?b=c#d",
            "about:blank",
            "about:srcdoc",
        ] {
            assert_eq!(decide(case), NavDecision::Allow, "`{case}`");
        }
    }

    #[test]
    fn a_garbage_string_is_a_block_not_a_pass_through() {
        for case in ["", "   ", "not a url", "http://", "://x", "\u{202E}"] {
            assert_eq!(
                decide(case),
                NavDecision::Block(BlockReason::Unparsable),
                "`{case}`"
            );
        }
    }

    // ── BC-5: the app's own origin, in BOTH profiles ────────────────────────

    /// Tauri's `is_local_url` calls the dev-server origin *local*, so a browser
    /// that reached it would clear the origin half of the ACL gate. This test
    /// is deliberately not `cfg(debug_assertions)`-gated: the rule exists in
    /// release too, so the release build cannot drift.
    #[test]
    fn the_app_and_dev_origins_are_blocked_in_every_build_profile() {
        for case in [
            "http://localhost:1420/",
            "http://localhost:1420/index.html",
            "http://127.0.0.1:1420/",
            "http://[::1]:1420/",
            "https://localhost:1420/",
            "https://tauri.localhost/index.html",
            "http://ipc.localhost/",
            "http://asset.localhost/x",
            "http://anything.localhost/",
        ] {
            assert_eq!(
                decide(case),
                NavDecision::Block(BlockReason::AppOrigin),
                "`{case}` must be refused as an app origin"
            );
        }
    }

    /// The two spellings a *resolver* treats as the app origin and a naive
    /// string/IP comparison does not. Both were wrong before `is_app_origin`
    /// normalized them, and the `*.localhost.` case was the bad one: it produced
    /// a plain **Allow**, i.e. a loopback reach with no user question at all,
    /// for a name every `*.localhost` resolver answers with `127.0.0.1`.
    #[test]
    fn the_app_origin_rule_survives_a_root_dot_and_a_mapped_address() {
        for case in [
            // The root dot. `Url` keeps it in the domain.
            "http://localhost.:1420/",
            "https://tauri.localhost./index.html",
            "http://ipc.localhost./",
            "http://anything.localhost./x",
            // The IPv4-mapped IPv6 spelling of the dev server.
            "http://[::ffff:127.0.0.1]:1420/",
            "http://[::ffff:7f00:1]:1420/",
        ] {
            assert_eq!(
                decide(case),
                NavDecision::Block(BlockReason::AppOrigin),
                "`{case}` must be refused as an app origin"
            );
        }
    }

    /// The positive control that proves the rule is about the *origin* and not
    /// about localhost generally — otherwise the test above would pass with a
    /// blanket "block localhost", which is a different (and wrong) rule.
    #[test]
    fn another_port_on_localhost_is_a_confirm_not_a_block() {
        assert_eq!(
            decide("http://localhost:8080/"),
            NavDecision::Confirm(ConfirmReason::Loopback)
        );
        assert_eq!(
            decide("http://127.0.0.1:3000/"),
            NavDecision::Confirm(ConfirmReason::Loopback)
        );
        // …and normalizing the root dot must not turn every `localhost.` URL
        // into the app origin: only the dev *port* is the app.
        assert_eq!(
            decide("http://localhost./"),
            NavDecision::Confirm(ConfirmReason::Loopback)
        );
        assert_eq!(
            decide("http://localhost.:8080/"),
            NavDecision::Confirm(ConfirmReason::Loopback)
        );
        assert_eq!(
            decide("http://[::ffff:127.0.0.1]:3000/"),
            NavDecision::Confirm(ConfirmReason::Loopback)
        );
    }

    // ── Intranet ────────────────────────────────────────────────────────────

    #[test]
    fn non_routable_addresses_need_a_confirmation() {
        for (case, want) in [
            ("http://127.0.0.1/", ConfirmReason::Loopback),
            ("http://localhost/", ConfirmReason::Loopback),
            ("http://[::1]/", ConfirmReason::Loopback),
            ("http://0.0.0.0/", ConfirmReason::Loopback),
            ("http://[::]/", ConfirmReason::Loopback),
            // Decimal / hex / octal IPv4 literals exist for exactly one reason.
            // The `url` crate normalizes them, which is why the gate takes a
            // parsed `Url` and never a string.
            ("http://2130706433/", ConfirmReason::Loopback),
            ("http://0x7f000001/", ConfirmReason::Loopback),
            ("http://017700000001/", ConfirmReason::Loopback),
            ("http://[::ffff:127.0.0.1]/", ConfirmReason::Loopback),
            (
                "http://169.254.169.254/latest/meta-data/",
                ConfirmReason::LinkLocal,
            ),
            ("http://[fe80::1]/", ConfirmReason::LinkLocal),
            ("http://10.1.2.3/", ConfirmReason::PrivateNetwork),
            ("http://172.16.0.1/", ConfirmReason::PrivateNetwork),
            ("http://172.31.255.255/", ConfirmReason::PrivateNetwork),
            ("http://192.168.1.1/", ConfirmReason::PrivateNetwork),
            ("http://100.64.0.1/", ConfirmReason::PrivateNetwork),
            ("http://[fc00::1]/", ConfirmReason::PrivateNetwork),
            ("http://router.local/", ConfirmReason::InternalName),
            ("http://box.internal/", ConfirmReason::InternalName),
            ("http://x.home.arpa/", ConfirmReason::InternalName),
        ] {
            assert_eq!(decide(case), NavDecision::Confirm(want), "`{case}`");
        }
    }

    /// The off-by-one boundaries. A range test that is one bit wrong fails open
    /// in exactly one direction and never shows up in the happy path.
    #[test]
    fn addresses_just_outside_each_private_range_stay_global() {
        for case in [
            "https://example.com/",
            "http://203.0.113.10/",
            "http://172.32.0.1/",
            "http://172.15.255.255/",
            "http://100.128.0.1/",
            "http://100.63.255.255/",
            "http://11.0.0.1/",
            "http://9.255.255.255/",
            "http://192.169.0.1/",
            "http://[2001:db8::1]/",
        ] {
            assert_eq!(decide(case), NavDecision::Allow, "`{case}`");
        }
    }

    // ── Downgrade / redirects ───────────────────────────────────────────────

    #[test]
    fn a_same_host_https_to_http_step_is_blocked() {
        let ctx = NavContext {
            current: Some(u("https://example.com/a")),
            redirects: 1,
        };
        assert_eq!(
            navigation_decision(&u("http://example.com/b"), &ctx),
            NavDecision::Block(BlockReason::Downgrade)
        );
        // A *different* host on http is not a downgrade, it is a different site.
        assert_eq!(
            navigation_decision(&u("http://other.example/b"), &ctx),
            NavDecision::Allow
        );
        // And a first-hop http is just an old site.
        assert_eq!(decide("http://example.com/b"), NavDecision::Allow);
    }

    #[test]
    fn a_chain_longer_than_the_cap_is_a_redirect_loop() {
        let ctx = NavContext {
            current: None,
            redirects: MAX_REDIRECTS + 1,
        };
        assert_eq!(
            navigation_decision(&u("https://example.com/"), &ctx),
            NavDecision::Block(BlockReason::RedirectLoop)
        );
    }

    // ── Totality ────────────────────────────────────────────────────────────

    /// The gate is called from a native callback on the UI thread. A panic
    /// there is not an error path, it is a dead window.
    #[test]
    fn the_gate_never_panics_on_hostile_input() {
        let mut seed: u64 = 0x5eed_1234_9abc_def0;
        let alphabet: Vec<char> =
            "abcxyzАВС:/?#[]@!$&'()*+,;=%.-_~\u{202E}\u{0000}\u{FEFF} 0129xn--"
                .chars()
                .collect();
        for _ in 0..10_000 {
            let mut s = String::new();
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            let len = (seed >> 33) as usize % 48;
            for _ in 0..len {
                seed = seed
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                s.push(alphabet[(seed >> 33) as usize % alphabet.len()]);
            }
            let (parsed, decision) = navigation_decision_str(&s, &NavContext::default());
            if parsed.is_none() {
                assert!(matches!(
                    decision,
                    NavDecision::Block(BlockReason::Unparsable)
                ));
            }
        }
    }

    // ── Display ─────────────────────────────────────────────────────────────

    #[test]
    fn userinfo_is_stripped_and_the_real_host_is_reported() {
        let d = describe_url(&u("https://example.com@evil.example/x"));
        assert!(d.userinfo, "the userinfo section must be flagged");
        assert_eq!(d.host, "evil.example");
        assert!(
            !d.display.contains("example.com@"),
            "the display form must not carry the decoy: {}",
            d.display
        );
    }

    #[test]
    fn a_punycode_host_reports_both_forms() {
        // `xn--80ak6aa92e` is the Cyrillic homograph of `apple`.
        let d = describe_url(&u("https://xn--80ak6aa92e.example/x"));
        assert_eq!(d.punycode.as_deref(), Some("xn--80ak6aa92e.example"));
        assert_ne!(
            d.host, "xn--80ak6aa92e.example",
            "the Unicode form is shown"
        );
        assert!(d.display.contains(&d.host));
    }

    #[test]
    fn a_plain_ascii_host_carries_no_punycode_warning() {
        let d = describe_url(&u("https://example.com/a?b=c"));
        assert_eq!(d.punycode, None);
        assert!(!d.userinfo);
        assert_eq!(d.host, "example.com");
    }

    #[test]
    fn a_very_long_url_is_never_truncated() {
        let long = format!("https://example.com/{}", "a".repeat(600));
        let d = describe_url(&u(&long));
        assert_eq!(d.display.len(), long.len());
    }

    #[test]
    fn format_controls_never_reach_a_label() {
        assert_eq!(
            strip_format_controls("example.com \u{202E}gnp.exe"),
            "example.com gnp.exe"
        );
        let d = describe_url(&u("https://example.com/\u{202E}x"));
        assert!(!d.display.contains('\u{202E}'));
    }

    // ── The moved filename sanitizer ────────────────────────────────────────
    //
    // Mail's full table stays in `mail_sanitize::tests` and runs against the
    // re-export, which is what proves there is ONE implementation. These cover
    // the download-specific shapes.

    #[test]
    fn a_download_name_cannot_traverse() {
        for hostile in [
            "../../etc/passwd",
            "..\\..\\windows\\system32\\cmd.exe",
            "/etc/passwd",
            "C:\\Users\\x\\evil.exe",
            "..",
            ".",
            "",
        ] {
            let safe = sanitize_attachment_name(hostile);
            assert!(!safe.value.contains('/'), "{hostile} -> {}", safe.value);
            assert!(!safe.value.contains('\\'), "{hostile} -> {}", safe.value);
            assert_ne!(safe.value, "..");
            assert_ne!(safe.value, ".");
            assert!(!safe.value.is_empty());
        }
    }

    // ── The reason-token contract ───────────────────────────────────────────

    /// Every reason the gate can produce must be in [`REASON_TOKENS`], because
    /// that array is what the frontend's i18n coverage test reads. The matches
    /// below are exhaustive on purpose: adding a variant stops compiling here
    /// rather than shipping a raw token to a user's screen.
    #[test]
    fn reason_tokens_are_exhaustive() {
        let confirms = [
            ConfirmReason::Loopback,
            ConfirmReason::PrivateNetwork,
            ConfirmReason::LinkLocal,
            ConfirmReason::InternalName,
        ];
        for c in confirms {
            // Exhaustiveness: a new variant breaks this match, not a user's day.
            match c {
                ConfirmReason::Loopback
                | ConfirmReason::PrivateNetwork
                | ConfirmReason::LinkLocal
                | ConfirmReason::InternalName => {}
            }
            let t = c.token();
            assert!(
                REASON_TOKENS.contains(&t),
                "confirm token `{t}` is unlisted"
            );
            // A reader fetch's later hops turn each of these into its own token.
            let hop = format!("redirect-to-{t}");
            assert!(
                REASON_TOKENS.contains(&hop.as_str()),
                "hop token `{hop}` is unlisted"
            );
        }

        let blocks = [
            BlockReason::Unparsable,
            BlockReason::Scheme("file".into()),
            BlockReason::AboutInternal,
            BlockReason::AppOrigin,
            BlockReason::Downgrade,
            BlockReason::RedirectLoop,
            BlockReason::NoHost,
        ];
        for b in blocks {
            match b {
                BlockReason::Unparsable
                | BlockReason::Scheme(_)
                | BlockReason::AboutInternal
                | BlockReason::AppOrigin
                | BlockReason::Downgrade
                | BlockReason::RedirectLoop
                | BlockReason::NoHost => {}
            }
            let t = b.token();
            assert!(
                REASON_TOKENS
                    .iter()
                    .any(|listed| t == *listed || t.starts_with(listed)),
                "block token `{t}` is unlisted"
            );
        }
    }

    #[test]
    fn the_bidi_extension_disguise_does_not_survive() {
        let safe = sanitize_attachment_name("invoice\u{202E}gnp.exe");
        assert!(!safe.value.contains('\u{202E}'));
        assert!(!safe.value.ends_with(".png"));
        assert!(safe.changed);
    }
}

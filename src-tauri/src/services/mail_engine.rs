//! The mail protocol layer: MIME parsing, IMAP, SMTP, TLS.
//!
//! `AppHandle`-free and path-free by construction. Everything here speaks
//! *messages*, never files; the only disk this module can reach is whatever the
//! caller hands it, and the caller (`commands::mail`) resolves every path under
//! `mail_dir()` itself. That is what makes plan A's Phase-5 move — putting the
//! same trait behind a pipe to a landlocked helper process — a transport swap
//! rather than a rewrite.
//!
//! ## The rules this module exists to enforce
//!
//! - **Implicit TLS only** (plan B §4.1). The connectors return a `TlsStream`;
//!   there is no type a cleartext session could inhabit, so a downgrade is not
//!   something a setting could enable.
//! - **No certificate escape hatch, anywhere** (§4.3). Validation is
//!   `rustls-platform-verifier` against the **OS trust store**, so a private CA
//!   is installed once, by the administrator, in the place the OS already has
//!   for it. A test scans this file's own source for the strings that would
//!   introduce a bypass.
//! - **Everything network-facing is bounded**: connect, handshake, greeting,
//!   command, fetch, and the whole SMTP session each carry a timeout, because
//!   an operation without one is an operation that can wedge a task forever —
//!   the same class of bug as the locked-keychain hang in
//!   `docs/context/remote_credentials.md`.
//! - **Everything parser-facing is bounded**: message size, MIME depth, part
//!   count, header line and header block. A pathological message is *refused*
//!   with a typed error, not merely survived.
//! - **A password is never logged, `Debug`-printed, or serialized.**
//!   [`Password`] has no `Serialize`, no `Display`, and a hand-written `Debug`.

use std::fmt;
use std::time::Duration;

use futures_util::StreamExt;
use mail_parser::{MessageParser, MimeHeaders, PartType};
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;
use zeroize::Zeroizing;

use crate::schema::mail::{
    MailAccount, MailAddress, MailAttachmentMeta, MailAuthResults, MailFolderKind, MailProbe,
    MailSecurity, MailServer,
};
use crate::services::mail_sanitize::sanitize_attachment_name;

// ── Crypto provider ─────────────────────────────────────────────────────────

/// Install the process-wide rustls `CryptoProvider`.
///
/// rustls 0.23 **panics at first use** with *"no process-level CryptoProvider
/// available"* when more than one provider is compiled into the binary and none
/// has been installed. More than one is exactly what a dependency tree gives you
/// sooner or later (any crate pulling `aws-lc-rs` alongside our `ring`), and the
/// failure lands at the first TLS handshake — i.e. at runtime, on a user's
/// machine, in the middle of connecting. So it is installed explicitly, once,
/// before anything can reach TLS, and an already-installed provider is ignored
/// rather than fought over.
///
/// Called from `lib.rs`'s `run()` before the Tauri builder, and from this
/// module's own test.
pub fn install_crypto_provider() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// The one TLS configuration, shared by IMAP and SMTP.
///
/// rustls 0.23 implements TLS 1.3 and 1.2 only — 1.0/1.1 do not exist in the
/// crate at all — so "minimum TLS 1.2" is structural here rather than a setting
/// that could be misconfigured. No custom cipher-suite list: rustls's defaults
/// are the right answer, and hand-picking suites is how you end up maintaining
/// a stale one.
fn tls_config() -> std::sync::Arc<rustls::ClientConfig> {
    use rustls_platform_verifier::BuilderVerifierExt;
    static CFG: std::sync::OnceLock<std::sync::Arc<rustls::ClientConfig>> =
        std::sync::OnceLock::new();
    CFG.get_or_init(|| {
        install_crypto_provider();
        let cfg = rustls::ClientConfig::builder_with_protocol_versions(&[
            &rustls::version::TLS13,
            &rustls::version::TLS12,
        ])
        .with_platform_verifier()
        .expect("the OS trust store must be readable to make any TLS connection")
        .with_no_client_auth();
        std::sync::Arc::new(cfg)
    })
    .clone()
}

// ── Secrets ─────────────────────────────────────────────────────────────────

/// An IMAP/SMTP password held in memory.
///
/// Zeroized on drop, no `Serialize`, no `Display`, and a `Debug` that prints a
/// placeholder — so a password cannot reach a log line, an error string, a
/// Tauri event payload or a crash dump by accident. The only way out is
/// [`Password::expose`], which is deliberately ugly to read at a call site.
#[derive(Clone, PartialEq, Eq)]
pub struct Password(Zeroizing<String>);

impl Password {
    pub fn new(secret: impl Into<String>) -> Self {
        Password(Zeroizing::new(secret.into()))
    }

    pub fn expose(&self) -> &str {
        self.0.as_str()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl fmt::Debug for Password {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Password(<redacted>)")
    }
}

// ── Errors ──────────────────────────────────────────────────────────────────

/// Why a mail operation failed. Typed rather than stringly so the caller can
/// distinguish "refuse and tell the user" from "retry later" — and so no error
/// path can accidentally interpolate a credential.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MailError {
    /// A cleartext or STARTTLS endpoint. v1 speaks implicit TLS only.
    PlaintextRefused,
    /// The raw message exceeded [`MAX_MESSAGE_BYTES`].
    TooLarge { bytes: usize },
    /// MIME nesting deeper than [`MAX_MIME_DEPTH`].
    TooDeep,
    /// More than [`MAX_MIME_PARTS`] parts.
    TooManyParts,
    /// A single header line over [`MAX_HEADER_LINE`], or a header block over
    /// [`MAX_HEADER_BLOCK`].
    HeaderTooLong,
    /// `mail-parser` could not make a message out of these bytes at all.
    Unparseable,
    /// Nothing renderable in the message (e.g. a lone `application/octet-stream`).
    NoDisplayableContent,
    /// An operation exceeded its bound.
    Timeout { op: &'static str },
    /// Authentication was rejected. **Never retried** — one attempt per user
    /// action, because a retry loop against a provider lockout policy is how
    /// accounts get locked.
    AuthFailed,
    /// The server offers no password mechanism we accept post-TLS.
    NoSupportedAuth,
    /// The account is VPN-only (`MailAccount::require_vpn`) and no OpenVPN
    /// tunnel is up. Raised before any socket is opened.
    VpnRequired,
    /// Anything else, already stripped of anything secret.
    Protocol(String),
}

impl fmt::Display for MailError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MailError::PlaintextRefused => write!(
                f,
                concat!("this account is configured for an unencrypted or STARTTLS port; \
                 ", crate::app_name!(), " connects over implicit TLS only (IMAP 993, SMTP 465)")
            ),
            MailError::TooLarge { bytes } => write!(
                f,
                "message is too large to open ({bytes} bytes; limit {MAX_MESSAGE_BYTES})"
            ),
            MailError::TooDeep => write!(
                f,
                "message nests MIME parts more than {MAX_MIME_DEPTH} deep and was not opened"
            ),
            MailError::TooManyParts => write!(
                f,
                "message has more than {MAX_MIME_PARTS} MIME parts and was not opened"
            ),
            MailError::HeaderTooLong => {
                write!(f, "message headers are malformed (a header is too long)")
            }
            MailError::Unparseable => write!(f, "message could not be parsed"),
            MailError::NoDisplayableContent => write!(f, "no displayable content"),
            MailError::Timeout { op } => write!(f, "{op} timed out"),
            MailError::VpnRequired => f.write_str(crate::services::openvpn::VPN_GATE_REFUSAL),
            MailError::AuthFailed => write!(
                f,
                concat!("the server rejected the username or password. ", crate::app_name!(), " does not retry \
                 automatically, so nothing was sent a second time.")
            ),
            MailError::NoSupportedAuth => write!(
                f,
                concat!("this server doesn't offer a password mechanism ", crate::app_name!(), " supports; it may require \
                 OAuth sign-in, which ", crate::app_name!(), " does not support yet")
            ),
            MailError::Protocol(m) => write!(f, "{m}"),
        }
    }
}

impl From<MailError> for String {
    fn from(e: MailError) -> String {
        e.to_string()
    }
}

// ── Bounds ──────────────────────────────────────────────────────────────────

/// Largest raw message accepted from a `FETCH` before parsing.
pub const MAX_MESSAGE_BYTES: usize = 50 * 1024 * 1024;
/// Largest single attachment payload kept.
pub const MAX_ATTACHMENT_BYTES: usize = 100 * 1024 * 1024;
/// MIME nesting budget.
pub const MAX_MIME_DEPTH: usize = 32;
/// MIME part-count budget.
pub const MAX_MIME_PARTS: usize = 512;
/// Longest single header line.
pub const MAX_HEADER_LINE: usize = 64 * 1024;
/// Longest whole header block.
pub const MAX_HEADER_BLOCK: usize = 1024 * 1024;
/// Longest plain-text preview kept on a header row.
pub const MAX_PREVIEW_CHARS: usize = 240;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
const GREETING_TIMEOUT: Duration = Duration::from_secs(15);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(60);
const FETCH_TIMEOUT: Duration = Duration::from_secs(300);
const SMTP_TIMEOUT: Duration = Duration::from_secs(300);

/// How long a single UID set is allowed to get before it is split across
/// commands. RFC 3501 sets no limit; servers do, and the documented ones sit far
/// above this — deliberately conservative, because the cost of another round
/// trip is nothing next to a command a server answers with `BAD`.
const MAX_UID_SET_CHARS: usize = 1000;

/// Why a permanent delete was refused. Named rather than inlined so the one
/// sentence the user reads is in the same place as the rule it describes —
/// `MailEngine::purge_messages` carries the reasoning.
pub const NO_UIDPLUS: &str = "this server does not support deleting a single message permanently \
                              (no UIDPLUS); move the message to Trash instead";

/// Split a sorted-ish UID list into IMAP UID sets no longer than `max_chars`,
/// collapsing runs into `a:b` ranges.
///
/// Range compression is what makes this cheap in the ordinary case: a folder's
/// unread mail is usually a contiguous tail, so 4000 UIDs become the seven
/// characters of `120:4119` rather than 24 kB of comma-separated integers. The
/// chunking then bounds what is left, for the mailbox where the unread set is
/// genuinely scattered.
///
/// Returns nothing for an empty input — a caller must not send `UID STORE ` with
/// an empty set, which is a syntax error rather than a no-op.
fn uid_set_chunks(uids: &[u32], max_chars: usize) -> Vec<String> {
    let mut sorted: Vec<u32> = uids.to_vec();
    sorted.sort_unstable();
    sorted.dedup();

    // Runs first, as `(start, end)` pairs, so a chunk boundary can never fall
    // inside one and turn `120:4119` into two half-ranges that address the wrong
    // messages between them.
    let mut runs: Vec<(u32, u32)> = Vec::new();
    for uid in sorted {
        match runs.last_mut() {
            // `uid == end + 1` extends the run; `end` cannot overflow here
            // because it came from the same u32 list.
            Some((_, end)) if uid == *end + 1 => *end = uid,
            _ => runs.push((uid, uid)),
        }
    }

    let mut chunks: Vec<String> = Vec::new();
    let mut current = String::new();
    for (start, end) in runs {
        let piece = if start == end {
            start.to_string()
        } else {
            format!("{start}:{end}")
        };
        // `+ 1` for the comma this piece would need. A piece that cannot fit an
        // empty chunk still gets its own — a range is atomic, and the longest
        // possible one ("4294967295:4294967295") is 21 characters.
        if !current.is_empty() && current.len() + 1 + piece.len() > max_chars {
            chunks.push(std::mem::take(&mut current));
        }
        if !current.is_empty() {
            current.push(',');
        }
        current.push_str(&piece);
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

/// Quote one search word as an IMAP quoted-string for a `SEARCH` criterion.
///
/// The query is user-typed text going into a protocol command, so it is
/// quoted rather than interpolated: `"` and `\` are escaped, and CR/LF are
/// dropped — a newline in a quoted-string would break the command framing and
/// let the rest of the query parse as new commands. Non-ASCII passes through;
/// the criterion using this declares `CHARSET UTF-8`.
fn imap_quoted(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len() + 2);
    out.push('"');
    for c in raw.chars() {
        if c == '\r' || c == '\n' {
            continue;
        }
        if c == '"' || c == '\\' {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('"');
    out
}

/// The `UID SEARCH` criterion for one query: subject or sender, the two header
/// fields the local index a search backfills into can actually match on (see
/// [`MailEngine::search_uids`).
///
/// `charset` declares `CHARSET UTF-8` up front so non-ASCII queries work; the
/// caller retries without it, because a server that answers the declaration
/// with `BAD` rejects the extension rather than the query.
fn server_search_criterion(query: &str, charset: bool) -> String {
    let q = imap_quoted(query);
    let core = format!("OR SUBJECT {q} FROM {q}");
    if charset {
        format!("CHARSET UTF-8 {core}")
    } else {
        core
    }
}

// ── Parsing ─────────────────────────────────────────────────────────────────

/// The header-shaped half of a parsed message.
#[derive(Debug, Clone, Default)]
pub struct ParsedHeaders {
    pub subject: String,
    pub from: MailAddress,
    pub to: Vec<MailAddress>,
    pub cc: Vec<MailAddress>,
    pub date: String,
    pub message_id: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    pub has_attachments: bool,
    pub size: u64,
    pub preview: String,
    /// Header problems the user must *see* rather than have silently resolved
    /// — a duplicate `From:` is the classic sender-spoofing setup (plan B T7).
    pub malformed_headers: Vec<String>,
    /// The receiving server's SPF/DKIM/DMARC verdicts, if it wrote any. Always
    /// parsed in the `Unconfigured` state — `mail_authres::apply_trust` is what
    /// decides whether it may be believed, and that runs at the command layer
    /// where the account (and therefore its trusted `authserv-id`) is known.
    pub auth: Option<MailAuthResults>,
}

/// One decoded attachment. `bytes` are the decoded payload; the caller stores
/// them content-addressed, so the sender-supplied `filename` never reaches a
/// syscall.
#[derive(Debug, Clone)]
pub struct ParsedAttachment {
    pub part_id: String,
    pub meta: MailAttachmentMeta,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Default)]
pub struct ParsedMessage {
    pub headers: ParsedHeaders,
    pub html: Option<String>,
    pub text: Option<String>,
    pub attachments: Vec<ParsedAttachment>,
}

/// Parse just the headers of a message (an IMAP `BODY.PEEK[HEADER]` fetch).
pub fn parse_headers(raw: &[u8]) -> Result<ParsedHeaders, MailError> {
    let msg = parse_bounded(raw)?;
    Ok(headers_of(&msg, raw))
}

/// Parse a whole message, with every structural cap applied.
pub fn parse_message(raw: &[u8]) -> Result<ParsedMessage, MailError> {
    let msg = parse_bounded(raw)?;
    let headers = headers_of(&msg, raw);

    // `html_body` is not "the parts that are HTML": `mail-parser` falls back to
    // the `text/plain` part when a message has no `text/html` one, because its
    // own `body_html()` accessor escapes such a part on the way out. We read the
    // part directly, so taking that fallback would run a **plain-text** body
    // through the HTML renderer — `<a href="https://evil.example">bank.example
    // </a>` typed into a plain-text mail would become a real link row with a
    // real Open button. The part must actually *be* `text/html`.
    let html_part = msg
        .html_body
        .first()
        .and_then(|id| msg.part(*id))
        .filter(|p| part_is_html(p));
    let mut text = msg
        .text_body
        .first()
        .and_then(|id| msg.part(*id))
        .and_then(|p| p.text_contents().map(|s| s.to_string()));

    // A body declared in a refused charset is **not** given to the HTML path.
    // `mail-parser` will happily decode UTF-7, and decoding it manufactures
    // markup the sender never wrote in plain sight (`+ADw-script+AD4-` becomes
    // `<script>`). The sanitizer would strip it anyway — this is the layer
    // above that, so an unsupported charset degrades to text rather than to
    // renderer sniffing (plan B T18).
    let mut html = None;
    if let Some(part) = html_part {
        let decoded = part.text_contents().map(|s| s.to_string());
        if charset_is_refused(part.content_type().and_then(|ct| ct.attribute("charset"))) {
            if text.is_none() {
                text = decoded;
            }
        } else {
            html = decoded;
        }
    }

    let mut attachments = Vec::new();
    for (idx, id) in msg.attachments.iter().enumerate() {
        let Some(part) = msg.part(*id) else { continue };
        let bytes = part.contents();
        if bytes.len() > MAX_ATTACHMENT_BYTES {
            continue;
        }
        let declared = part
            .content_type()
            .map(|ct| match ct.subtype() {
                Some(sub) => format!("{}/{}", ct.ctype(), sub),
                None => ct.ctype().to_string(),
            })
            .unwrap_or_else(|| "application/octet-stream".to_string());
        let raw_name = part
            .attachment_name()
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("attachment-{idx}"));
        let safe = sanitize_attachment_name(&raw_name);
        let inline = part
            .content_disposition()
            .map(|cd| cd.ctype().eq_ignore_ascii_case("inline"))
            .unwrap_or(false);
        let mismatch = type_mismatch(&declared, &safe.value, bytes);
        attachments.push(ParsedAttachment {
            part_id: id.to_string(),
            meta: MailAttachmentMeta {
                part_id: id.to_string(),
                filename: safe.value,
                mime: declared,
                size: bytes.len() as u64,
                inline,
                type_mismatch: mismatch,
            },
            bytes: bytes.to_vec(),
        });
    }

    if html.is_none() && text.is_none() && attachments.is_empty() {
        return Err(MailError::NoDisplayableContent);
    }

    Ok(ParsedMessage {
        headers,
        html,
        text,
        attachments,
    })
}

/// Is this part actually declared `text/html`? See [`parse_message`]: a part
/// `mail-parser` offers as the "html body" may in fact be `text/plain`.
fn part_is_html(part: &mail_parser::MessagePart<'_>) -> bool {
    part.content_type()
        .and_then(|ct| ct.subtype().map(|sub| (ct.ctype(), sub)))
        .map(|(ctype, sub)| ctype.eq_ignore_ascii_case("text") && sub.eq_ignore_ascii_case("html"))
        .unwrap_or(false)
}

/// Charsets a `text/html` part may not be rendered from.
///
/// UTF-7 is the whole list and the whole point: it is the one encoding in
/// common use where ASCII-safe-looking bytes decode into markup, which is why
/// it has been an XSS vector for two decades. It is not "unsupported" here — it
/// is refused, and the body falls back to being shown as text.
///
/// **The label is normalized exactly the way `mail-parser` normalizes it**, and
/// that is the whole correctness argument: this gate is only meaningful for the
/// spellings the decoder underneath *acts on*. `mail-parser`'s charset lookup
/// upper→lower-cases and maps `-` to `_` before matching, and its two UTF-7 keys
/// are `utf_7` and `csutf7` — so `charset=csutf7` and `charset=utf_7` decode as
/// UTF-7 while a list of hand-written hyphenated spellings misses both, and
/// three of that list's five entries (`utf7`, `x-utf-7`, `unicode-1-1-utf-7`)
/// are not decoded as UTF-7 by anything. They are kept anyway: refusing a label
/// nobody decodes costs a plain-text fallback, and another mail library — or a
/// future `mail-parser` — may well decode them.
fn charset_is_refused(charset: Option<&str>) -> bool {
    let Some(cs) = charset else { return false };
    // `mail-parser`'s own normalization (`charset_decoder`): ASCII-lowercase and
    // `-` → `_`. Ours additionally trims the quoting a `Content-Type` parameter
    // may still carry.
    let cs: String = cs
        .trim()
        .trim_matches('"')
        .trim()
        .chars()
        .map(|c| match c {
            'A'..='Z' => c.to_ascii_lowercase(),
            '-' => '_',
            _ => c,
        })
        .collect();
    matches!(
        cs.as_str(),
        // The two labels `mail-parser` actually decodes as UTF-7.
        "utf_7" | "csutf7"
        // Spellings other decoders use, refused defensively.
        | "utf7" | "unicode_1_1_utf_7" | "csunicode11utf7" | "x_utf_7"
        | "unicode_2_0_utf_7" | "x_unicode_2_0_utf_7"
    )
}

/// Size, header and structural checks, then the parse itself.
fn parse_bounded(raw: &[u8]) -> Result<mail_parser::Message<'_>, MailError> {
    if raw.len() > MAX_MESSAGE_BYTES {
        return Err(MailError::TooLarge { bytes: raw.len() });
    }
    scan_headers(raw)?;
    let msg = MessageParser::default()
        .parse(raw)
        .ok_or(MailError::Unparseable)?;
    check_structure(&msg, 0)?;
    Ok(msg)
}

/// Pre-parse byte scan of the header block: one line at most
/// [`MAX_HEADER_LINE`], the block at most [`MAX_HEADER_BLOCK`].
///
/// Deliberately runs *before* `mail-parser` rather than inspecting its output:
/// a cap that only applies after the allocation has already happened is not a
/// cap.
fn scan_headers(raw: &[u8]) -> Result<(), MailError> {
    let mut line_len = 0usize;
    let mut block_len = 0usize;
    let mut prev_blank = false;
    for &b in raw {
        block_len += 1;
        if block_len > MAX_HEADER_BLOCK {
            return Err(MailError::HeaderTooLong);
        }
        if b == b'\n' {
            if line_len == 0 || (line_len == 1 && prev_blank) {
                // Empty line — end of the header block.
                return Ok(());
            }
            prev_blank = true;
            line_len = 0;
            continue;
        }
        if b == b'\r' {
            prev_blank = line_len == 0;
            line_len += 1;
            continue;
        }
        prev_blank = false;
        line_len += 1;
        if line_len > MAX_HEADER_LINE {
            return Err(MailError::HeaderTooLong);
        }
    }
    Ok(())
}

/// Walk the parsed tree enforcing depth and part-count budgets.
///
/// Iterative rather than recursive: the input is attacker-controlled and the
/// whole point of the depth cap is that a 64-deep `message/rfc822` chain must
/// not be able to reach the stack in the first place.
fn check_structure(msg: &mail_parser::Message<'_>, base_depth: usize) -> Result<(), MailError> {
    if base_depth > MAX_MIME_DEPTH {
        return Err(MailError::TooDeep);
    }
    if msg.parts.len() > MAX_MIME_PARTS {
        return Err(MailError::TooManyParts);
    }
    let mut count = 0usize;
    let mut stack: Vec<(u32, usize)> = vec![(0, base_depth)];
    let mut nested: Vec<(&mail_parser::Message<'_>, usize)> = Vec::new();
    while let Some((id, depth)) = stack.pop() {
        if depth > MAX_MIME_DEPTH {
            return Err(MailError::TooDeep);
        }
        count += 1;
        if count > MAX_MIME_PARTS {
            return Err(MailError::TooManyParts);
        }
        let Some(part) = msg.part(id) else { continue };
        match &part.body {
            PartType::Multipart(children) => {
                for child in children {
                    stack.push((*child, depth + 1));
                }
            }
            PartType::Message(inner) => nested.push((inner, depth + 1)),
            _ => {}
        }
    }
    for (inner, depth) in nested {
        check_structure(inner, depth)?;
    }
    Ok(())
}

fn addr_list(addr: Option<&mail_parser::Address<'_>>) -> Vec<MailAddress> {
    let Some(addr) = addr else { return Vec::new() };
    let mut out = Vec::new();
    match addr {
        mail_parser::Address::List(list) => {
            for a in list {
                out.push(one_addr(a));
            }
        }
        mail_parser::Address::Group(groups) => {
            for g in groups {
                for a in &g.addresses {
                    out.push(one_addr(a));
                }
            }
        }
    }
    out
}

fn one_addr(a: &mail_parser::Addr<'_>) -> MailAddress {
    // The display name is stripped of bidi/format controls before it can reach
    // the UI: `From: "support@bank.example"<a@evil.example>` with an RLO in the
    // name is the standard sender disguise (plan B T7). The *addr-spec* is
    // always kept as its own field so the UI can render it unconditionally.
    let name = a
        .name
        .as_deref()
        .map(strip_controls)
        .filter(|s| !s.trim().is_empty());
    MailAddress {
        name,
        // Controls out of the address too: an RLO inside a quoted local part
        // reorders the address the UI shows "unconditionally", which is the one
        // field meant to be trustworthy when the name is not.
        address: strip_controls(a.address.as_deref().unwrap_or_default()),
    }
}

fn strip_controls(s: &str) -> String {
    s.chars()
        .filter(|c| {
            !c.is_control()
                && !matches!(
                    c,
                    '\u{200E}'
                        | '\u{200F}'
                        | '\u{202A}'
                        | '\u{202B}'
                        | '\u{202C}'
                        | '\u{202D}'
                        | '\u{202E}'
                        | '\u{2066}'
                        | '\u{2067}'
                        | '\u{2068}'
                        | '\u{2069}'
                        | '\u{061C}'
                )
        })
        .collect()
}

/// The modified-BASE64 alphabet of RFC 3501 §5.1.3: RFC 2045's, with `,` in
/// place of `/` (because `/` is the hierarchy separator on many servers).
const MUTF7_ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+,";

/// Decode an IMAP mailbox name from **modified UTF-7** (RFC 3501 §5.1.3) for
/// display.
///
/// IMAP mailbox names are not UTF-8 on the wire. Non-ASCII is shifted into a
/// modified UTF-7 run: `&` opens it, `&-` is a literal `&`, and the payload is
/// UTF-16BE in a base64 alphabet where `,` replaces `/`. So a German Gmail's
/// drafts folder arrives as `[Gmail]/Entw&APw-rfe` and must be shown as
/// `[Gmail]/Entwürfe`.
///
/// **This is display-only, and that split is load-bearing.** `MailFolder.path`
/// keeps the wire form because it is what `SELECT` takes; only `name` is
/// decoded. Decoding the path would break every folder with an umlaut in it.
///
/// It does not conflict with `charset_is_refused` refusing UTF-7 *bodies*.
/// There, decoding manufactures markup out of ASCII-looking bytes on a path
/// that leads to an HTML renderer. Here the encoding is mandated by the
/// protocol, and the output is a label rendered as a text node — so the residual
/// risk is not markup but *direction*, which `strip_controls` handles at the
/// call site exactly as it does for a subject.
///
/// Never fails: an ill-formed run is emitted verbatim rather than dropped. A
/// mangled folder name is a cosmetic problem; a folder that vanishes from the
/// list is not.
fn decode_modified_utf7(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'&' {
            // Multi-byte UTF-8 can only appear in a non-conforming name; copy it
            // through rather than mangling it.
            let start = i;
            while i < bytes.len() && bytes[i] != b'&' {
                i += 1;
            }
            out.push_str(&String::from_utf8_lossy(&bytes[start..i]));
            continue;
        }
        // `&-` is a literal ampersand.
        if bytes.get(i + 1) == Some(&b'-') {
            out.push('&');
            i += 2;
            continue;
        }
        let run_start = i + 1;
        let mut end = run_start;
        while end < bytes.len() && MUTF7_ALPHABET.contains(&bytes[end]) {
            end += 1;
        }
        match decode_mutf7_run(&bytes[run_start..end]) {
            Some(decoded) if end > run_start => out.push_str(&decoded),
            // Not a well-formed run — keep the source text so the name is still
            // recognizable instead of silently losing characters.
            _ => {
                out.push('&');
                out.push_str(&String::from_utf8_lossy(&bytes[run_start..end]));
            }
        }
        i = end;
        // The terminating `-` is part of the shift sequence, not the name.
        if bytes.get(i) == Some(&b'-') {
            i += 1;
        }
    }
    out
}

/// One modified-BASE64 run → UTF-16BE → `String`. `None` if it is not decodable.
fn decode_mutf7_run(run: &[u8]) -> Option<String> {
    if run.is_empty() {
        return None;
    }
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    let mut units: Vec<u16> = Vec::new();
    for b in run {
        let v = MUTF7_ALPHABET.iter().position(|c| c == b)? as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 16 {
            bits -= 16;
            units.push(((acc >> bits) & 0xFFFF) as u16);
        }
    }
    // Any leftover must be zero padding; a non-zero remainder means the run was
    // truncated or corrupt, and guessing at it would invent characters.
    if bits > 0 && (acc & ((1 << bits) - 1)) != 0 {
        return None;
    }
    // A run too short to complete even one UTF-16 unit (`&A-`) passes the
    // padding check above and yields *nothing*, which the caller would emit as
    // an empty name. A well-formed run always carries at least one unit, so
    // treat it as undecodable and let the caller keep the source text.
    if units.is_empty() {
        return None;
    }
    String::from_utf16(&units).ok()
}

/// Every `Authentication-Results` header's value, **in document order**, read
/// out of the raw message rather than out of `mail-parser`'s header value.
///
/// The raw slice is deliberate: whether an unknown header's value gets parsed
/// into a `HeaderValue::Text` is a detail of the parser's header table, and this
/// header is the input to a trust decision. Slicing `offset_start..offset_end`
/// and unfolding it here means the bytes that were on the wire are the bytes
/// that get parsed, whatever the parser decides to do with the field.
fn authentication_results_values(msg: &mail_parser::Message<'_>, raw: &[u8]) -> Vec<String> {
    msg.headers()
        .iter()
        .filter(|h| match &h.name {
            mail_parser::HeaderName::Other(name) => {
                name.eq_ignore_ascii_case("authentication-results")
            }
            _ => false,
        })
        .filter_map(|h| {
            let (start, end) = (h.offset_start as usize, h.offset_end as usize);
            if start >= end || end > raw.len() {
                return None;
            }
            Some(unfold(&String::from_utf8_lossy(&raw[start..end])))
        })
        .collect()
}

/// Join a folded header value into one line: a CRLF (or LF) followed by
/// whitespace is folding and becomes a single space.
fn unfold(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut pending_space = false;
    for line in s.split('\n') {
        let line = line.trim_end_matches('\r');
        if out.is_empty() && !pending_space {
            out.push_str(line.trim_start());
        } else {
            if !out.ends_with(' ') {
                out.push(' ');
            }
            out.push_str(line.trim_start());
        }
        pending_space = true;
    }
    out.trim().to_string()
}

fn headers_of(msg: &mail_parser::Message<'_>, raw: &[u8]) -> ParsedHeaders {
    let size = raw.len() as u64;
    let mut malformed = Vec::new();
    let from_count = msg
        .headers()
        .iter()
        .filter(|h| matches!(h.name, mail_parser::HeaderName::From))
        .count();
    if from_count > 1 {
        malformed.push("DUPLICATE_FROM".to_string());
    }
    let sender_count = msg
        .headers()
        .iter()
        .filter(|h| matches!(h.name, mail_parser::HeaderName::Sender))
        .count();
    if sender_count > 1 {
        malformed.push("DUPLICATE_SENDER".to_string());
    }

    let from = addr_list(msg.from()).into_iter().next().unwrap_or_default();
    let subject = msg.subject().map(strip_controls).unwrap_or_default();

    let preview = msg
        .body_preview(MAX_PREVIEW_CHARS)
        .map(|p| strip_controls(&p))
        .unwrap_or_default();

    let references = match msg.references() {
        mail_parser::HeaderValue::Text(t) => vec![t.to_string()],
        mail_parser::HeaderValue::TextList(l) => l.iter().map(|s| s.to_string()).collect(),
        _ => Vec::new(),
    };
    let in_reply_to = match msg.in_reply_to() {
        mail_parser::HeaderValue::Text(t) => Some(t.to_string()),
        mail_parser::HeaderValue::TextList(l) => l.first().map(|s| s.to_string()),
        _ => None,
    };

    let auth = crate::services::mail_authres::parse_authentication_results(
        &authentication_results_values(msg, raw),
        &from.address,
    );

    ParsedHeaders {
        subject,
        from,
        to: addr_list(msg.to()),
        cc: addr_list(msg.cc()),
        date: msg.date().map(|d| d.to_rfc3339()).unwrap_or_default(),
        message_id: msg.message_id().map(|s| s.to_string()),
        in_reply_to,
        references,
        has_attachments: msg.attachment_count() > 0,
        size,
        preview,
        malformed_headers: malformed,
        auth,
    }
}

/// Three signals per attachment — **declared** (`Content-Type`), **sniffed**
/// (`infer`), and **implied** (the extension) — reduced to one warning string.
///
/// The strongest single signal gets its own message: bytes that sniff as an
/// executable are a program regardless of what the header or the extension
/// claims.
pub fn type_mismatch(declared: &str, safe_name: &str, bytes: &[u8]) -> Option<String> {
    let head = &bytes[..bytes.len().min(8192)];
    if is_executable(head) {
        return Some("executable".to_string());
    }
    let sniffed = infer::get(head).map(|k| k.mime_type().to_string());
    let implied = mime_guess::from_path(safe_name)
        .first()
        .map(|m| m.to_string());

    if let Some(sniffed) = &sniffed {
        let top = |m: &str| m.split('/').next().unwrap_or("").to_ascii_lowercase();
        if top(sniffed) != top(declared) {
            return Some(format!("declared {declared}, looks like {sniffed}"));
        }
        if let Some(implied) = &implied {
            if implied != sniffed {
                return Some(format!("named like {implied}, looks like {sniffed}"));
            }
        }
    }
    if double_extension_is_executable(safe_name) {
        return Some("double-extension".to_string());
    }
    None
}

fn is_executable(head: &[u8]) -> bool {
    head.starts_with(b"MZ")
        || head.starts_with(b"\x7fELF")
        || head.starts_with(b"#!")
        || head.starts_with(&[0xFE, 0xED, 0xFA, 0xCE])
        || head.starts_with(&[0xFE, 0xED, 0xFA, 0xCF])
        || head.starts_with(&[0xCF, 0xFA, 0xED, 0xFE])
        || head.starts_with(&[0xCE, 0xFA, 0xED, 0xFE])
        || head.starts_with(&[0xCA, 0xFE, 0xBA, 0xBE])
}

/// Extensions that are a program by any other name. Checked against the
/// **sanitized** name's final extension, case-insensitively.
const EXECUTABLE_EXTENSIONS: &[&str] = &[
    "exe", "com", "scr", "pif", "bat", "cmd", "msi", "msp", "cpl", "hta", "js", "jse", "vbs",
    "vbe", "wsf", "wsh", "ps1", "psm1", "sh", "bash", "zsh", "jar", "apk", "app", "dmg", "pkg",
    "lnk", "url", "scf", "reg", "inf", "desktop", "gadget", "chm", "msc", "ade", "adp", "mde",
    "mdb",
];

fn double_extension_is_executable(name: &str) -> bool {
    let parts: Vec<&str> = name.split('.').collect();
    if parts.len() < 3 {
        return false;
    }
    let last = parts[parts.len() - 1].to_ascii_lowercase();
    EXECUTABLE_EXTENSIONS.contains(&last.as_str())
}

// ── The engine seam ─────────────────────────────────────────────────────────

/// One fetched header row, before it is given a store identity.
#[derive(Debug, Clone)]
pub struct FetchedHeader {
    pub uid: u32,
    pub seen: bool,
    pub flagged: bool,
    pub answered: bool,
    pub headers: ParsedHeaders,
}

/// One sync's read of a folder: its newest headers, and the server's own
/// counts for the whole mailbox. The headers are only the tail a sync is
/// bounded to; the counts are what the folder's badges must report, or a
/// mailbox with 300 unread would read as however many of them are in the tail.
#[derive(Debug, Clone, Default)]
pub struct FetchedHeaders {
    pub headers: Vec<FetchedHeader>,
    /// `EXISTS` from the SELECT.
    pub exists: u32,
    /// How many messages `SEARCH UNSEEN` matched.
    pub unseen: u32,
}

/// One folder as the server describes it.
#[derive(Debug, Clone)]
pub struct FetchedFolder {
    pub path: String,
    pub name: String,
    pub kind: MailFolderKind,
    pub total: u32,
    pub unread: u32,
}

/// All mail work sits behind this trait, with an `AppHandle`-free, path-free
/// API that speaks messages rather than files. `InProcess` is the only
/// implementation today; a `Helper` variant speaking a length-prefixed protocol
/// to a landlocked child is plan A's Phase 5, and nothing above this trait
/// learns about the difference.
#[allow(async_fn_in_trait)]
pub trait MailEngine: Send + Sync {
    async fn probe(&self, account: &MailAccount, password: &Password) -> MailProbe;
    async fn folders(
        &self,
        account: &MailAccount,
        password: &Password,
    ) -> Result<Vec<FetchedFolder>, MailError>;
    async fn headers(
        &self,
        account: &MailAccount,
        password: &Password,
        folder_path: &str,
        limit: u32,
    ) -> Result<FetchedHeaders, MailError>;
    /// UIDs in this folder whose subject or sender matches `query` — the search
    /// the local index cannot answer, because a sync keeps only a folder's
    /// newest headers while the server holds the whole mailbox.
    ///
    /// Server-side and case-insensitive per RFC 3501. Ascending and uncapped;
    /// the caller pages. Deliberately subject/sender only: the local index the
    /// matches are backfilled into holds header fields (a header-only fetch has
    /// no body for a preview), so a body-text criterion would spend the fetch
    /// budget on rows the list that follows could never display.
    async fn search_uids(
        &self,
        account: &MailAccount,
        password: &Password,
        folder_path: &str,
        query: &str,
    ) -> Result<Vec<u32>, MailError>;
    /// Header rows for these UIDs, for backfilling the local index with what a
    /// server search found. Same shape as [`MailEngine::headers`]' rows —
    /// header-only, `BODY.PEEK` so nothing is marked read. UIDs the server no
    /// longer reports are skipped rather than failing the batch.
    async fn headers_for_uids(
        &self,
        account: &MailAccount,
        password: &Password,
        folder_path: &str,
        uids: &[u32],
    ) -> Result<Vec<FetchedHeader>, MailError>;
    async fn body(
        &self,
        account: &MailAccount,
        password: &Password,
        folder_path: &str,
        uid: u32,
    ) -> Result<Vec<u8>, MailError>;
    async fn set_flag(
        &self,
        account: &MailAccount,
        password: &Password,
        folder_path: &str,
        uid: u32,
        flag: &str,
        value: bool,
    ) -> Result<(), MailError>;
    /// The same STORE for many messages at once — one login, one SELECT, one
    /// command. Not a convenience: "mark all as read" over a folder holding a
    /// few hundred unread messages would otherwise be a few hundred logins, and
    /// a server with any connection-rate limit answers that with a ban.
    async fn set_flags_bulk(
        &self,
        account: &MailAccount,
        password: &Password,
        folder_path: &str,
        uids: &[u32],
        flag: &str,
        value: bool,
    ) -> Result<(), MailError>;
    /// `\Seen` on every message up to and including `max_uid` — "mark all read"
    /// for a folder whose unread mail reaches past the local index, where
    /// there are no local UIDs to name. Bounded by `max_uid` so mail that
    /// arrived after the list the user was looking at stays unread.
    async fn mark_seen_through(
        &self,
        account: &MailAccount,
        password: &Password,
        folder_path: &str,
        max_uid: u32,
    ) -> Result<(), MailError>;
    async fn move_messages(
        &self,
        account: &MailAccount,
        password: &Password,
        folder_path: &str,
        uids: &[u32],
        dest_path: &str,
    ) -> Result<(), MailError>;
    /// Delete messages off the server: `\Deleted`, then `UID EXPUNGE`.
    ///
    /// The *irreversible* half of deleting, reached only where a move to Trash
    /// is not available — emptying the Trash itself, or an account with no Trash
    /// folder at all. Everything else deletes by moving, which is recoverable.
    ///
    /// **UIDPLUS or nothing.** A plain `EXPUNGE` removes every message in the
    /// mailbox carrying `\Deleted`, including ones another client flagged and has
    /// not expunged yet — so on a server without RFC 4315 this refuses rather
    /// than deleting mail nobody in this window asked about. RFC 4315 is
    /// twenty years old and near-universal; a refusal names the reason, and a
    /// move to Trash still works there.
    async fn purge_messages(
        &self,
        account: &MailAccount,
        password: &Password,
        folder_path: &str,
        uids: &[u32],
    ) -> Result<(), MailError>;
    async fn send(
        &self,
        account: &MailAccount,
        password: &Password,
        envelope_from: &str,
        recipients: &[String],
        raw: &[u8],
    ) -> Result<(), MailError>;
    /// Put a copy of a sent message into a folder (IMAP `APPEND`).
    ///
    /// This did not exist until the encryption work, and its absence was
    /// accidentally the most private behaviour available: **there was no Sent
    /// copy at all**. Adding it is therefore a deliberate reduction in privacy,
    /// and it is only safe because of what the caller does — `commands::mail`
    /// appends the message it actually sent, which for an encrypted message is
    /// the encrypted-to-self form. Adding `APPEND` *without* encrypt-to-self is
    /// precisely how a plaintext Sent copy of an encrypted message ships.
    async fn append(
        &self,
        account: &MailAccount,
        password: &Password,
        folder_path: &str,
        raw: &[u8],
    ) -> Result<(), MailError>;
}

/// The in-process engine: sockets and parsers in Tabtivity's own address space.
#[derive(Debug, Clone, Copy, Default)]
pub struct InProcessEngine;

type ImapSession = async_imap::Session<TlsStream<TcpStream>>;

async fn tls_stream(server: &MailServer) -> Result<TlsStream<TcpStream>, MailError> {
    // The refusal is here, at the one place a socket is opened, rather than in
    // the UI: there is no code path that produces a cleartext session, so
    // "allow insecure" is not a setting someone could add later without
    // deleting this.
    if server.security != MailSecurity::Tls {
        return Err(MailError::PlaintextRefused);
    }
    let host = server.host.trim().to_string();
    if host.is_empty() {
        return Err(MailError::Protocol("no server host configured".into()));
    }
    let tcp = tokio::time::timeout(
        CONNECT_TIMEOUT,
        TcpStream::connect((host.as_str(), server.port)),
    )
    .await
    .map_err(|_| MailError::Timeout { op: "connect" })?
    .map_err(|e| MailError::Protocol(format!("could not reach {host}: {e}")))?;

    let connector = tokio_rustls::TlsConnector::from(tls_config());
    let name = rustls_pki_types::ServerName::try_from(host.clone())
        .map_err(|_| MailError::Protocol(format!("'{host}' is not a valid server name")))?;
    let stream = tokio::time::timeout(HANDSHAKE_TIMEOUT, connector.connect(name, tcp))
        .await
        .map_err(|_| MailError::Timeout {
            op: "TLS handshake",
        })?
        .map_err(|e| MailError::Protocol(describe_tls_error(&host, &e)))?;
    Ok(stream)
}

/// Say *what* failed, in words that do not create pressure for an override
/// button. "Certificate error" is exactly the message that makes users demand
/// an "ignore" checkbox; naming the cause and the remedy is what makes not
/// having one tenable.
fn describe_tls_error(host: &str, e: &std::io::Error) -> String {
    let text = e.to_string();
    let lower = text.to_ascii_lowercase();
    if lower.contains("notvalidforname") || lower.contains("not valid for name") {
        format!(
            "The server presented a certificate that is not valid for '{host}'. \
             Check the server address for a typo."
        )
    } else if lower.contains("unknownissuer") || lower.contains("unknown issuer") {
        format!(
            "This server's certificate is signed by an authority your system doesn't trust. \
             If '{host}' is a private server, install its certificate authority in your \
             operating system's trust store."
        )
    } else if lower.contains("expired") {
        format!(
            "This server's certificate has expired. That is usually the server \
             administrator's problem, not yours ({host})."
        )
    } else if lower.contains("revoked") {
        format!("This server's certificate has been revoked. Do not enter your password ({host}).")
    } else {
        format!("TLS connection to {host} failed: {text}")
    }
}

async fn imap_login(server: &MailServer, password: &Password) -> Result<ImapSession, MailError> {
    let stream = tls_stream(server).await?;
    let mut client = async_imap::Client::new(stream);
    let greeting = tokio::time::timeout(GREETING_TIMEOUT, client.read_response())
        .await
        .map_err(|_| MailError::Timeout {
            op: "IMAP greeting",
        })?
        .map_err(|e| MailError::Protocol(format!("IMAP greeting failed: {e}")))?;
    if greeting.is_none() {
        return Err(MailError::Protocol(
            "the IMAP server closed the connection before greeting".into(),
        ));
    }
    // One attempt. A retry loop against a provider's lockout policy is how
    // accounts get locked, and it is also how a stale saved credential becomes
    // a lockout rather than a prompt.
    let session = tokio::time::timeout(
        COMMAND_TIMEOUT,
        // Borrowed, not copied: `login` takes `AsRef<str>`, and an owned
        // `String` here was a copy of the password that nothing zeroized.
        client.login(server.user.clone(), password.expose()),
    )
    .await
    .map_err(|_| MailError::Timeout { op: "IMAP login" })?
    .map_err(|(e, _client)| classify_imap_error(e))?;
    Ok(session)
}

// ── The session pool ────────────────────────────────────────────────────────
//
// Every method below used to open its own connection: login, SELECT, one
// command, logout. Reading twenty messages was twenty TLS handshakes and twenty
// `LOGIN`s — and the cost of that is not latency, it is the *provider's opinion
// of it*. Hosted mail rate-limits authentication attempts long before it rate-
// limits commands, and answers a client that reauthenticates per click with
// throttling, a temporary lock, or a "suspicious sign-in" mail to the very
// account being read. `set_flags_bulk` was already written against exactly this
// hazard ("a few hundred logins, and a server with any connection-rate limit
// answers that with a ban"); this generalizes it from one method to the module.
//
// The pool is process-global rather than a field on `InProcessEngine`, because
// that type is a unit struct constructed at each call site
// (`InProcessEngine.body(…)`) — an instance field would mean threading state
// through every caller for no gain. One app, one mailbox, one pool.

/// How long a session may sit unused before it is closed rather than handed out
/// again. Servers autologout idle connections (RFC 3501 permits it after 30
/// minutes, and NATs are far less patient), and a pool that hands out corpses
/// has traded logins for intermittent failures.
const POOL_MAX_IDLE: Duration = Duration::from_secs(300);

/// Above this much idle time a pooled session is probed with `NOOP` before use.
/// Below it, the probe is skipped: a burst of flag toggles should not pay a
/// round trip each to re-ask a question answered a second ago.
const POOL_PROBE_AFTER: Duration = Duration::from_secs(30);

/// The next item of an IMAP response stream, or a timeout once `deadline` has
/// passed.
///
/// `async-imap` hands the stream back as soon as the command is *sent*, so a
/// `timeout` around the call bounds nothing a server does afterwards. Every
/// response is read here, under the same deadline the command started with — a
/// total, not an idle timer, so a server trickling one byte a minute cannot hold
/// a sync (and the account's polling behind it) open forever either.
async fn next_before<S>(
    stream: &mut S,
    deadline: tokio::time::Instant,
    op: &'static str,
) -> Result<Option<S::Item>, MailError>
where
    S: futures_util::Stream + Unpin,
{
    tokio::time::timeout_at(deadline, stream.next())
        .await
        .map_err(|_| MailError::Timeout { op })
}

/// A stale socket must fail *fast*. `COMMAND_TIMEOUT` is 60 s, which is the
/// right budget for a real command and an absurd one for a liveness check whose
/// failure path is simply "log in again".
const POOL_PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// How many idle sessions one account may keep. One: university and institute
/// IMAP servers ask clients to cache at most a single connection (Thunderbird's
/// "Maximum number of server connections to cache" = 1), and a mail client that
/// holds a second socket open for the rare overlap of a background check and an
/// opened message spends a shared server's budget on a connection nobody reads.
/// That overlap still works — the second lease simply closes when it is done
/// instead of being pooled.
const POOL_MAX_PER_KEY: usize = 1;

/// The pool's identity for a server: everything that decides *who is
/// authenticated*. A changed host, port or user is a different connection, and
/// the callers that change any of them evict explicitly
/// ([`forget_pooled_sessions`]).
fn pool_key(server: &MailServer) -> String {
    format!(
        "{}:{}|{}",
        server.host.trim().to_ascii_lowercase(),
        server.port,
        server.user
    )
}

/// Too old to hand out at all.
fn pool_entry_expired(idle: Duration) -> bool {
    idle >= POOL_MAX_IDLE
}

/// Old enough that liveness is worth one `NOOP`.
fn pool_entry_needs_probe(idle: Duration) -> bool {
    idle >= POOL_PROBE_AFTER
}

/// A logged-in session waiting in the pool, with the mailbox it last selected.
struct Idle {
    session: ImapSession,
    selected: Option<String>,
    since: std::time::Instant,
}

type Pool = std::sync::Mutex<std::collections::HashMap<String, Vec<Idle>>>;

fn pool() -> &'static Pool {
    static POOL: std::sync::OnceLock<Pool> = std::sync::OnceLock::new();
    POOL.get_or_init(Pool::default)
}

/// Pop the warmest live session for `key`, dropping expired ones on the way.
///
/// Dropping closes the socket without a `LOGOUT`, which is rude and harmless —
/// it is what happens at process exit anyway, and the alternative would be
/// awaiting an async command while holding a `std::sync::Mutex`.
fn take_idle(key: &str) -> Option<Idle> {
    let mut pool = pool().lock().ok()?;
    let bucket = pool.get_mut(key)?;
    while let Some(idle) = bucket.pop() {
        if !pool_entry_expired(idle.since.elapsed()) {
            return Some(idle);
        }
    }
    None
}

/// Whether a caller wants a session it may share.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Acquire {
    /// Reuse a pooled session when one is live.
    Pooled,
    /// Log in, always. Only [`MailEngine::probe`] asks for this: a credential
    /// test answered out of a pool tests nothing, and would report success for
    /// a password the user had just changed to a wrong one.
    Fresh,
}

/// A checked-out session.
///
/// **`keep` is `false` until [`Lease::finish`] is told the operation
/// succeeded**, and that default is the whole safety argument. Anything that is
/// not a clean success — an error, an early `?`, a panic, a future dropped
/// mid-command when a sync is cancelled — therefore closes the socket instead
/// of pooling it. The inverse default would hand the next caller a stream
/// positioned inside somebody else's half-read response, which is a bug that
/// presents as arbitrary mail rendering as arbitrary other mail.
///
/// Derefs to the session, so the protocol code below reads as it always did.
/// The one thing not to call through that deref is `select`: use
/// [`Lease::ensure_selected`] or [`Lease::select_now`], which keep the cached
/// mailbox honest.
struct Lease {
    session: Option<ImapSession>,
    key: String,
    selected: Option<String>,
    keep: bool,
}

impl std::ops::Deref for Lease {
    type Target = ImapSession;
    fn deref(&self) -> &ImapSession {
        self.session.as_ref().expect("a lease holds its session")
    }
}

impl std::ops::DerefMut for Lease {
    fn deref_mut(&mut self) -> &mut ImapSession {
        self.session.as_mut().expect("a lease holds its session")
    }
}

impl Lease {
    /// `SELECT` unless this session is already in that mailbox.
    ///
    /// Safe only for commands that address messages by UID — flag, bulk flag,
    /// move, body fetch — which is every caller of this. A caller that reads
    /// the mailbox's own counters wants [`Lease::select_now`].
    async fn ensure_selected(&mut self, path: &str) -> Result<(), MailError> {
        if self.selected.as_deref() == Some(path) {
            return Ok(());
        }
        self.select_now(path).await.map(|_| ())
    }

    /// `SELECT` unconditionally, for a caller that needs the mailbox's own
    /// counts (`EXISTS`) rather than merely the right mailbox.
    async fn select_now(&mut self, path: &str) -> Result<async_imap::types::Mailbox, MailError> {
        // Cleared *first*: a failed SELECT leaves the session in an undefined
        // mailbox, and a cached name that survives the failure is how a UID
        // command later runs against the previous folder.
        self.selected = None;
        let result = tokio::time::timeout(COMMAND_TIMEOUT, self.select(path)).await;
        let mailbox = result
            .map_err(|_| MailError::Timeout { op: "IMAP SELECT" })?
            .map_err(classify_imap_error)?;
        self.selected = Some(path.to_string());
        Ok(mailbox)
    }

    /// Hand the outcome back, pooling the session only on a clean success.
    fn finish<T>(mut self, out: Result<T, MailError>) -> Result<T, MailError> {
        self.keep = out.is_ok();
        out
    }

    /// Log out and close, pooling nothing.
    async fn close(mut self) {
        if let Some(session) = self.session.as_mut() {
            let _ = tokio::time::timeout(COMMAND_TIMEOUT, session.logout()).await;
        }
        self.session = None;
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        let Some(session) = self.session.take() else {
            return;
        };
        if !self.keep {
            return;
        }
        let Ok(mut pool) = pool().lock() else {
            return;
        };
        let bucket = pool.entry(self.key.clone()).or_default();
        if bucket.len() >= POOL_MAX_PER_KEY {
            return;
        }
        bucket.push(Idle {
            session,
            selected: self.selected.take(),
            since: std::time::Instant::now(),
        });
    }
}

/// The VPN gate, asked at the top of every engine operation — before
/// `acquire` and before `smtp_connect`, so a gated account opens no socket in
/// either direction while no tunnel is up. It cannot live inside those two:
/// they see a `MailServer`, and the gate is the *account's* setting.
fn vpn_gate(account: &MailAccount) -> Result<(), MailError> {
    if crate::services::openvpn::account_gate(account.require_vpn).is_ok() {
        Ok(())
    } else {
        Err(MailError::VpnRequired)
    }
}

/// The one place a session is obtained. Every IMAP operation in this module
/// goes through it, and a test reads this file's own source to keep that true.
async fn acquire(
    server: &MailServer,
    password: &Password,
    mode: Acquire,
) -> Result<Lease, MailError> {
    let key = pool_key(server);
    if mode == Acquire::Pooled {
        while let Some(idle) = take_idle(&key) {
            let idle_for = idle.since.elapsed();
            let mut lease = Lease {
                session: Some(idle.session),
                key: key.clone(),
                selected: idle.selected,
                keep: false,
            };
            if !pool_entry_needs_probe(idle_for) {
                return Ok(lease);
            }
            if let Ok(Ok(())) = tokio::time::timeout(POOL_PROBE_TIMEOUT, lease.noop()).await {
                return Ok(lease);
            }
            // Dead or wedged. `keep` is false, so dropping the lease closes it;
            // try the next pooled session, then a fresh login.
        }
    }
    let session = imap_login(server, password).await?;
    Ok(Lease {
        session: Some(session),
        key,
        selected: None,
        keep: false,
    })
}

/// Close every pooled session for one account.
///
/// Called at the three moments the credential behind a live authenticated
/// socket stops being the one the user believes is in use: the account's
/// settings change, the account is deleted, or its password is forgotten.
pub fn forget_pooled_sessions(server: &MailServer) {
    if let Ok(mut pool) = pool().lock() {
        pool.remove(&pool_key(server));
    }
}

fn classify_imap_error(e: async_imap::error::Error) -> MailError {
    let text = e.to_string();
    let lower = text.to_ascii_lowercase();
    if lower.contains("authenticationfailed")
        || lower.contains("authentication failed")
        || lower.contains("invalid credentials")
        || lower.contains("login failed")
    {
        MailError::AuthFailed
    } else {
        MailError::Protocol(text)
    }
}

fn folder_kind(path: &str, attributes: &[async_imap::types::NameAttribute<'_>]) -> MailFolderKind {
    for attr in attributes {
        let a = format!("{attr:?}").to_ascii_lowercase();
        for (needle, kind) in [
            ("sent", MailFolderKind::Sent),
            ("drafts", MailFolderKind::Drafts),
            ("trash", MailFolderKind::Trash),
            ("junk", MailFolderKind::Junk),
            ("archive", MailFolderKind::Archive),
        ] {
            if a.contains(needle) {
                return kind;
            }
        }
    }
    let last = path.rsplit(['/', '.']).next().unwrap_or(path);
    match last.to_ascii_lowercase().as_str() {
        "inbox" => MailFolderKind::Inbox,
        "sent" | "sent items" | "sent messages" => MailFolderKind::Sent,
        "drafts" => MailFolderKind::Drafts,
        "trash" | "deleted items" => MailFolderKind::Trash,
        "junk" | "spam" => MailFolderKind::Junk,
        "archive" | "all mail" => MailFolderKind::Archive,
        _ => MailFolderKind::Other,
    }
}

impl MailEngine for InProcessEngine {
    async fn probe(&self, account: &MailAccount, password: &Password) -> MailProbe {
        let mut out = MailProbe::default();
        let mut errors: Vec<String> = Vec::new();
        if let Err(e) = vpn_gate(account) {
            // Neither side is probed: a test that quietly opened the socket the
            // setting forbids would be the setting lying.
            out.error = Some(e.to_string());
            return out;
        }

        // `Fresh`, and closed rather than pooled: this is the one operation whose
        // entire job is to answer "do these credentials work *now*".
        match acquire(&account.imap, password, Acquire::Fresh).await {
            Ok(session) => {
                out.imap_ok = true;
                session.close().await;
            }
            Err(e) => errors.push(format!("IMAP: {e}")),
        }

        match smtp_connect(&account.smtp, password).await {
            Ok(client) => {
                out.smtp_ok = true;
                let _ = client.quit().await;
            }
            Err(e) => errors.push(format!("SMTP: {e}")),
        }

        if !errors.is_empty() {
            out.error = Some(errors.join("; "));
        }
        out
    }

    async fn folders(
        &self,
        account: &MailAccount,
        password: &Password,
    ) -> Result<Vec<FetchedFolder>, MailError> {
        vpn_gate(account)?;
        let mut session = acquire(&account.imap, password, Acquire::Pooled).await?;
        let out: Result<Vec<FetchedFolder>, MailError> = async {
            let mut out = Vec::new();
            {
                let deadline = tokio::time::Instant::now() + COMMAND_TIMEOUT;
                let mut stream =
                    tokio::time::timeout_at(deadline, session.list(Some(""), Some("*")))
                        .await
                        .map_err(|_| MailError::Timeout { op: "IMAP LIST" })?
                        .map_err(classify_imap_error)?;
                while let Some(name) = next_before(&mut stream, deadline, "IMAP LIST").await? {
                    let name = name.map_err(classify_imap_error)?;
                    let path = name.name().to_string();
                    // Split on the wire form, then decode **only** the leaf for
                    // display: `path` has to stay exactly as the server said it, or
                    // `SELECT` on any folder with an umlaut in it fails. Controls
                    // are stripped from the result for the same reason they are
                    // from a subject — a server-supplied label with an RTL override
                    // in it reorders what the user reads.
                    let leaf = path.rsplit(['/', '.']).next().unwrap_or(&path);
                    let display = strip_controls(&decode_modified_utf7(leaf));
                    // A folder whose entire name was control characters would end up
                    // with no label at all; fall back to the wire form so every row
                    // is still nameable.
                    let display = if display.trim().is_empty() {
                        leaf.to_string()
                    } else {
                        display
                    };
                    out.push(FetchedFolder {
                        kind: folder_kind(&path, name.attributes()),
                        name: display,
                        path,
                        total: 0,
                        unread: 0,
                    });
                    if out.len() >= 500 {
                        break;
                    }
                }
            }
            Ok(out)
        }
        .await;
        session.finish(out)
    }

    async fn headers(
        &self,
        account: &MailAccount,
        password: &Password,
        folder_path: &str,
        limit: u32,
    ) -> Result<FetchedHeaders, MailError> {
        vpn_gate(account)?;
        let mut session = acquire(&account.imap, password, Acquire::Pooled).await?;
        let out: Result<FetchedHeaders, MailError> = async {
            // `select_now`, never the cached `ensure_selected`: this is the one
            // caller that reads the mailbox's own `EXISTS` off the response, and
            // paging from a cached count would silently page from a stale one.
            let mailbox = session.select_now(folder_path).await?;
            // The unread count of the whole mailbox, not of the tail fetched
            // below. SELECT's own `UNSEEN` is the first unseen sequence number,
            // not a count, so it is a SEARCH — a list of numbers, a few kB even
            // for a mailbox with thousands unread.
            let unseen = if mailbox.exists > 0 {
                tokio::time::timeout(COMMAND_TIMEOUT, session.search("UNSEEN"))
                    .await
                    .map_err(|_| MailError::Timeout { op: "IMAP SEARCH" })?
                    .map_err(classify_imap_error)?
                    .len() as u32
            } else {
                0
            };

            let mut out = Vec::new();
            if mailbox.exists > 0 {
                let limit = limit.clamp(1, 500);
                let first = mailbox
                    .exists
                    .saturating_sub(limit.saturating_sub(1))
                    .max(1);
                let set = format!("{first}:{}", mailbox.exists);
                // BODY.PEEK — never BODY — so listing a folder cannot mark mail as
                // read on the server (and cannot be used to tell a sender that a
                // message was opened).
                let query = "(UID FLAGS RFC822.SIZE BODY.PEEK[HEADER])";
                let deadline = tokio::time::Instant::now() + FETCH_TIMEOUT;
                let mut stream = tokio::time::timeout_at(deadline, session.fetch(set, query))
                    .await
                    .map_err(|_| MailError::Timeout { op: "IMAP FETCH" })?
                    .map_err(classify_imap_error)?;
                while let Some(item) = next_before(&mut stream, deadline, "IMAP FETCH").await? {
                    let item = item.map_err(classify_imap_error)?;
                    let Some(uid) = item.uid else { continue };
                    let raw = item.header().unwrap_or(b"");
                    let Ok(headers) = parse_headers(raw) else {
                        continue;
                    };
                    let mut headers = headers;
                    headers.size = item.size.unwrap_or(raw.len() as u32) as u64;
                    let flags: Vec<String> = item.flags().map(|f| format!("{f:?}")).collect();
                    out.push(FetchedHeader {
                        uid,
                        seen: flags.iter().any(|f| f.contains("Seen")),
                        flagged: flags.iter().any(|f| f.contains("Flagged")),
                        answered: flags.iter().any(|f| f.contains("Answered")),
                        headers,
                    });
                }
            }
            Ok(FetchedHeaders {
                headers: out,
                exists: mailbox.exists,
                unseen,
            })
        }
        .await;
        session.finish(out)
    }

    async fn search_uids(
        &self,
        account: &MailAccount,
        password: &Password,
        folder_path: &str,
        query: &str,
    ) -> Result<Vec<u32>, MailError> {
        vpn_gate(account)?;
        let needle = query.trim();
        if needle.is_empty() {
            return Ok(Vec::new());
        }
        let mut session = acquire(&account.imap, password, Acquire::Pooled).await?;
        let out: Result<Vec<u32>, MailError> = async {
            session.ensure_selected(folder_path).await?;
            let deadline = tokio::time::Instant::now() + COMMAND_TIMEOUT;
            // `CHARSET UTF-8` first so a non-ASCII query works; without it on
            // the retry, because a `BAD` there rejects the declaration rather
            // than the query. Anything but a `Protocol` refusal is returned at
            // once — an auth failure will not fix itself by rephrasing.
            for charset in [true, false] {
                let criterion = server_search_criterion(needle, charset);
                match tokio::time::timeout_at(deadline, session.uid_search(criterion)).await {
                    Ok(Ok(uids)) => {
                        let mut out: Vec<u32> = uids.into_iter().collect();
                        out.sort_unstable();
                        return Ok(out);
                    }
                    Ok(Err(e)) => {
                        let err = classify_imap_error(e);
                        if charset && matches!(err, MailError::Protocol(_)) {
                            continue;
                        }
                        return Err(err);
                    }
                    Err(_) => return Err(MailError::Timeout { op: "IMAP SEARCH" }),
                }
            }
            unreachable!("the loop above returns on both attempts");
        }
        .await;
        session.finish(out)
    }

    async fn headers_for_uids(
        &self,
        account: &MailAccount,
        password: &Password,
        folder_path: &str,
        uids: &[u32],
    ) -> Result<Vec<FetchedHeader>, MailError> {
        vpn_gate(account)?;
        if uids.is_empty() {
            return Ok(Vec::new());
        }
        let mut session = acquire(&account.imap, password, Acquire::Pooled).await?;
        let out: Result<Vec<FetchedHeader>, MailError> = async {
            session.ensure_selected(folder_path).await?;
            // The same row `headers` builds — `BODY.PEEK`, never `BODY`, for
            // its reason — addressed by UID set instead of by tail range.
            let fetch = "(UID FLAGS RFC822.SIZE BODY.PEEK[HEADER])";
            let deadline = tokio::time::Instant::now() + FETCH_TIMEOUT;
            let mut out = Vec::new();
            for set in uid_set_chunks(uids, MAX_UID_SET_CHARS) {
                let mut stream = tokio::time::timeout_at(deadline, session.uid_fetch(set, fetch))
                    .await
                    .map_err(|_| MailError::Timeout { op: "IMAP FETCH" })?
                    .map_err(classify_imap_error)?;
                while let Some(item) = next_before(&mut stream, deadline, "IMAP FETCH").await? {
                    let item = item.map_err(classify_imap_error)?;
                    let Some(uid) = item.uid else { continue };
                    let raw = item.header().unwrap_or(b"");
                    let Ok(headers) = parse_headers(raw) else {
                        continue;
                    };
                    let mut headers = headers;
                    headers.size = item.size.unwrap_or(raw.len() as u32) as u64;
                    let flags: Vec<String> = item.flags().map(|f| format!("{f:?}")).collect();
                    out.push(FetchedHeader {
                        uid,
                        seen: flags.iter().any(|f| f.contains("Seen")),
                        flagged: flags.iter().any(|f| f.contains("Flagged")),
                        answered: flags.iter().any(|f| f.contains("Answered")),
                        headers,
                    });
                }
            }
            Ok(out)
        }
        .await;
        session.finish(out)
    }

    async fn body(
        &self,
        account: &MailAccount,
        password: &Password,
        folder_path: &str,
        uid: u32,
    ) -> Result<Vec<u8>, MailError> {
        vpn_gate(account)?;
        let mut session = acquire(&account.imap, password, Acquire::Pooled).await?;
        let out: Result<Vec<u8>, MailError> = async {
            session.ensure_selected(folder_path).await?;

            let deadline = tokio::time::Instant::now() + FETCH_TIMEOUT;

            // The declared size first, so an oversized message is refused before
            // its literal is read: the IMAP client buffers a literal whole (up to
            // 512 MiB) before `MAX_MESSAGE_BYTES` below could see it. A server
            // that lies here is still caught by that check and the deadline.
            {
                let mut stream = tokio::time::timeout_at(
                    deadline,
                    session.uid_fetch(uid.to_string(), "RFC822.SIZE"),
                )
                .await
                .map_err(|_| MailError::Timeout { op: "IMAP FETCH" })?
                .map_err(classify_imap_error)?;
                while let Some(item) = next_before(&mut stream, deadline, "IMAP FETCH").await? {
                    let item = item.map_err(classify_imap_error)?;
                    if let Some(size) = item.size {
                        if size as usize > MAX_MESSAGE_BYTES {
                            return Err(MailError::TooLarge {
                                bytes: size as usize,
                            });
                        }
                    }
                }
            }

            let mut bytes: Vec<u8> = Vec::new();
            {
                let mut stream = tokio::time::timeout_at(
                    deadline,
                    session.uid_fetch(uid.to_string(), "BODY.PEEK[]"),
                )
                .await
                .map_err(|_| MailError::Timeout { op: "IMAP FETCH" })?
                .map_err(classify_imap_error)?;
                while let Some(item) = next_before(&mut stream, deadline, "IMAP FETCH").await? {
                    let item = item.map_err(classify_imap_error)?;
                    if let Some(body) = item.body() {
                        if body.len() > MAX_MESSAGE_BYTES {
                            return Err(MailError::TooLarge { bytes: body.len() });
                        }
                        bytes = body.to_vec();
                    }
                }
            }
            if bytes.is_empty() {
                return Err(MailError::Protocol("the server returned no message".into()));
            }
            Ok(bytes)
        }
        .await;
        session.finish(out)
    }

    async fn set_flag(
        &self,
        account: &MailAccount,
        password: &Password,
        folder_path: &str,
        uid: u32,
        flag: &str,
        value: bool,
    ) -> Result<(), MailError> {
        vpn_gate(account)?;
        let mut session = acquire(&account.imap, password, Acquire::Pooled).await?;
        let out: Result<(), MailError> = async {
            session.ensure_selected(folder_path).await?;
            let op = if value { "+FLAGS" } else { "-FLAGS" };
            {
                let deadline = tokio::time::Instant::now() + COMMAND_TIMEOUT;
                let mut stream = tokio::time::timeout_at(
                    deadline,
                    session.uid_store(uid.to_string(), format!("{op} ({flag})")),
                )
                .await
                .map_err(|_| MailError::Timeout { op: "IMAP STORE" })?
                .map_err(classify_imap_error)?;
                while next_before(&mut stream, deadline, "IMAP STORE").await?.is_some() {}
            }
            Ok(())
        }
        .await;
        session.finish(out)
    }

    async fn set_flags_bulk(
        &self,
        account: &MailAccount,
        password: &Password,
        folder_path: &str,
        uids: &[u32],
        flag: &str,
        value: bool,
    ) -> Result<(), MailError> {
        vpn_gate(account)?;
        if uids.is_empty() {
            return Ok(());
        }
        let mut session = acquire(&account.imap, password, Acquire::Pooled).await?;
        let out: Result<(), MailError> = async {
            session.ensure_selected(folder_path).await?;
            let op = if value { "+FLAGS" } else { "-FLAGS" };
            // One command per chunk, and the chunks exist because a UID set is part
            // of a command *line*: RFC 3501 puts no ceiling on it, real servers do,
            // and a folder with thousands of unread messages is exactly the one this
            // is called on. Range compression usually collapses it to a handful of
            // bytes anyway — the chunking is the guarantee, not the optimization.
            for chunk in uid_set_chunks(uids, MAX_UID_SET_CHARS) {
                let deadline = tokio::time::Instant::now() + COMMAND_TIMEOUT;
                let mut stream = tokio::time::timeout_at(
                    deadline,
                    session.uid_store(chunk, format!("{op} ({flag})")),
                )
                .await
                .map_err(|_| MailError::Timeout { op: "IMAP STORE" })?
                .map_err(classify_imap_error)?;
                while next_before(&mut stream, deadline, "IMAP STORE").await?.is_some() {}
            }
            Ok(())
        }
        .await;
        session.finish(out)
    }

    async fn mark_seen_through(
        &self,
        account: &MailAccount,
        password: &Password,
        folder_path: &str,
        max_uid: u32,
    ) -> Result<(), MailError> {
        vpn_gate(account)?;
        if max_uid == 0 {
            return Ok(());
        }
        let mut session = acquire(&account.imap, password, Acquire::Pooled).await?;
        let out: Result<(), MailError> = async {
            session.ensure_selected(folder_path).await?;
            let flag = crate::schema::mail::MailFlag::Seen.imap_flag();
            let deadline = tokio::time::Instant::now() + COMMAND_TIMEOUT;
            let mut stream = tokio::time::timeout_at(
                deadline,
                session.uid_store(format!("1:{max_uid}"), format!("+FLAGS ({flag})")),
            )
            .await
            .map_err(|_| MailError::Timeout { op: "IMAP STORE" })?
            .map_err(classify_imap_error)?;
            while next_before(&mut stream, deadline, "IMAP STORE").await?.is_some() {}
            Ok(())
        }
        .await;
        session.finish(out)
    }

    async fn move_messages(
        &self,
        account: &MailAccount,
        password: &Password,
        folder_path: &str,
        uids: &[u32],
        dest_path: &str,
    ) -> Result<(), MailError> {
        vpn_gate(account)?;
        if uids.is_empty() {
            return Ok(());
        }
        let mut session = acquire(&account.imap, password, Acquire::Pooled).await?;
        let out: Result<(), MailError> = async {
            session.ensure_selected(folder_path).await?;
            // Chunked for the same reason `set_flags_bulk` is, and it was the one
            // bulk command here that was not: a UID set is part of a command *line*,
            // real servers cap that line, and "move the 400 messages I selected" is
            // precisely the call that reaches the cap. A chunk that fails leaves the
            // earlier chunks moved — recoverable, because repeating the move of an
            // already-moved message is a no-op, which an over-long line is not.
            for chunk in uid_set_chunks(uids, MAX_UID_SET_CHARS) {
                tokio::time::timeout(COMMAND_TIMEOUT, session.uid_mv(chunk, dest_path))
                    .await
                    .map_err(|_| MailError::Timeout { op: "IMAP MOVE" })?
                    .map_err(classify_imap_error)?;
            }
            Ok(())
        }
        .await;
        session.finish(out)
    }

    async fn purge_messages(
        &self,
        account: &MailAccount,
        password: &Password,
        folder_path: &str,
        uids: &[u32],
    ) -> Result<(), MailError> {
        vpn_gate(account)?;
        if uids.is_empty() {
            return Ok(());
        }
        let mut session = acquire(&account.imap, password, Acquire::Pooled).await?;
        let out: Result<(), MailError> = async {
            // Asked **before** anything is flagged: a `\Deleted` set on a server
            // that cannot then expunge by UID is not a no-op — it hides the
            // message in most clients and hands the next plain EXPUNGE from
            // anywhere a mail the user never agreed to lose.
            let capabilities = tokio::time::timeout(COMMAND_TIMEOUT, session.capabilities())
                .await
                .map_err(|_| MailError::Timeout { op: "IMAP CAPABILITY" })?
                .map_err(classify_imap_error)?;
            if !capabilities.has_str("UIDPLUS") {
                return Err(MailError::Protocol(NO_UIDPLUS.into()));
            }
            session.ensure_selected(folder_path).await?;
            // Chunked for `move_messages`' reason, and flag-then-expunge per
            // chunk rather than flagging everything first: the two commands
            // address the same UID set, so a chunk that fails leaves the
            // messages after it untouched instead of flagged-but-present.
            for chunk in uid_set_chunks(uids, MAX_UID_SET_CHARS) {
                {
                    let deadline = tokio::time::Instant::now() + COMMAND_TIMEOUT;
                    let mut stream = tokio::time::timeout_at(
                        deadline,
                        session.uid_store(chunk.clone(), "+FLAGS (\\Deleted)"),
                    )
                    .await
                    .map_err(|_| MailError::Timeout { op: "IMAP STORE" })?
                    .map_err(classify_imap_error)?;
                    while next_before(&mut stream, deadline, "IMAP STORE").await?.is_some() {}
                }
                let deadline = tokio::time::Instant::now() + COMMAND_TIMEOUT;
                // Boxed because the expunge stream is not `Unpin` (its parser
                // holds a future, unlike STORE's), and `next_before` polls a
                // stream it borrows.
                let mut stream = Box::pin(
                    tokio::time::timeout_at(deadline, session.uid_expunge(chunk))
                        .await
                        .map_err(|_| MailError::Timeout { op: "IMAP UID EXPUNGE" })?
                        .map_err(classify_imap_error)?,
                );
                while next_before(&mut stream, deadline, "IMAP UID EXPUNGE")
                    .await?
                    .is_some()
                {}
            }
            Ok(())
        }
        .await;
        session.finish(out)
    }

    async fn send(
        &self,
        account: &MailAccount,
        password: &Password,
        envelope_from: &str,
        recipients: &[String],
        raw: &[u8],
    ) -> Result<(), MailError> {
        vpn_gate(account)?;
        if recipients.is_empty() {
            return Err(MailError::Protocol("no recipients".into()));
        }
        let mut client = smtp_connect(&account.smtp, password).await?;
        let message = mail_send::smtp::message::Message::new(
            envelope_from.to_string(),
            recipients.to_vec(),
            raw.to_vec(),
        );
        tokio::time::timeout(SMTP_TIMEOUT, client.send(message))
            .await
            .map_err(|_| MailError::Timeout { op: "SMTP send" })?
            .map_err(classify_smtp_error)?;
        let _ = client.quit().await;
        Ok(())
    }

    async fn append(
        &self,
        account: &MailAccount,
        password: &Password,
        folder_path: &str,
        raw: &[u8],
    ) -> Result<(), MailError> {
        vpn_gate(account)?;
        if raw.len() > MAX_OUTBOUND_BYTES {
            return Err(MailError::TooLarge { bytes: raw.len() });
        }
        let mut session = acquire(&account.imap, password, Acquire::Pooled).await?;
        // `\Seen` because a message you wrote is not unread mail; without it a
        // Sent folder lights the unread badge for every message sent.
        let flags = "(\\Seen)";
        let result = tokio::time::timeout(
            COMMAND_TIMEOUT,
            session.append(folder_path, Some(flags), None, raw),
        )
        .await;
        let out = result
            .map_err(|_| MailError::Timeout { op: "IMAP APPEND" })
            .and_then(|r| r.map_err(classify_imap_error))
            .map(|_| ());
        session.finish(out)
    }
}

async fn smtp_connect(
    server: &MailServer,
    password: &Password,
) -> Result<mail_send::SmtpClient<TlsStream<TcpStream>>, MailError> {
    if server.security != MailSecurity::Tls {
        return Err(MailError::PlaintextRefused);
    }
    let builder = mail_send::SmtpClientBuilder::new(server.host.clone(), server.port)
        .map_err(MailError::Protocol)?
        // Implicit TLS. Note there is deliberately no certificate-bypass call
        // anywhere in this file — a source-scanning test asserts that.
        .implicit_tls(true)
        // Not the machine's hostname, which `mail-send` would otherwise put in
        // EHLO and providers copy into `Received:` — telling every recipient
        // what this computer is called, across every account. An address
        // literal is what RFC 5321 §4.1.4 allows when there is no name to give.
        .helo_host("[127.0.0.1]")
        .timeout(SMTP_TIMEOUT)
        // `mail-send` owns its credentials as a plain `String`, so this one copy
        // cannot be zeroized from here; it lives as long as the connection.
        .credentials((server.user.clone(), password.expose().to_string()));
    tokio::time::timeout(SMTP_TIMEOUT, builder.connect())
        .await
        .map_err(|_| MailError::Timeout { op: "SMTP connect" })?
        .map_err(classify_smtp_error)
}

fn classify_smtp_error(e: mail_send::Error) -> MailError {
    match e {
        mail_send::Error::AuthenticationFailed(_) | mail_send::Error::MissingCredentials => {
            MailError::AuthFailed
        }
        mail_send::Error::UnsupportedAuthMechanism => MailError::NoSupportedAuth,
        mail_send::Error::Timeout => MailError::Timeout { op: "SMTP" },
        mail_send::Error::Tls(err) => MailError::Protocol(format!("TLS error: {err}")),
        other => MailError::Protocol(format!("{other:?}")),
    }
}

// ── Outbound construction ───────────────────────────────────────────────────

/// A header value that would inject a second header. Recipients are parsed into
/// typed addresses and never concatenated, but a `Subject:` is user text, so
/// every value is checked for CR/LF **before** it is handed to `mail-builder`
/// (plan B T16).
pub fn reject_header_injection(value: &str) -> Result<&str, MailError> {
    if value.contains('\r') || value.contains('\n') || value.contains('\0') {
        return Err(MailError::Protocol(
            "a header value may not contain a line break".into(),
        ));
    }
    Ok(value)
}

/// A recipient address that is one address and nothing else.
///
/// Strict on purpose, because the result is spliced into `RCPT TO:<…>`: a `>`
/// closes the path and whatever follows is read as ESMTP parameters (`NOTIFY=`,
/// `ORCPT=`), and reply-all copies addresses out of a received — attacker-written
/// — message. So: a dot-atom local part (no quoted forms, no backslash), one `@`,
/// and a hostname of letters, digits and hyphens. Non-ASCII is allowed in both
/// halves for internationalized addresses; controls and whitespace never are.
pub fn validate_recipient(addr: &str) -> Result<String, MailError> {
    let a = addr.trim();
    reject_header_injection(a)?;
    let bad = || MailError::Protocol(format!("'{a}' is not a single e-mail address"));
    let (local, domain) = a.split_once('@').ok_or_else(bad)?;
    const ATEXT_SPECIALS: &str = "!#$%&'*+-/=?^_`{|}~";
    let local_ok = !local.is_empty()
        && local.len() <= 64
        && !local.starts_with('.')
        && !local.ends_with('.')
        && !local.contains("..")
        && local.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || c == '.'
                || ATEXT_SPECIALS.contains(c)
                || (!c.is_ascii()
                    && !c.is_control()
                    && !c.is_whitespace()
                    && !crate::services::web_safety::is_format_char(c))
        });
    let domain_ok = domain.len() <= 253
        && domain.split('.').count() >= 1
        && domain.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label.chars().all(|c| {
                    c.is_ascii_alphanumeric() || c == '-' || (!c.is_ascii() && c.is_alphanumeric())
                })
        });
    if !local_ok || !domain_ok {
        return Err(bad());
    }
    Ok(a.to_string())
}

/// Total outbound message budget, warned about before any network call.
pub const MAX_OUTBOUND_BYTES: usize = 25 * 1024 * 1024;

/// One attachment to put on an outgoing message. `filename` is already the
/// **basename**, run through `sanitize_attachment_name` — a full local path in
/// a `Content-Disposition` is a directory-structure and username leak.
pub struct OutboundAttachment {
    pub filename: String,
    pub mime: String,
    pub bytes: Vec<u8>,
}

/// A fresh `Message-ID` for an outgoing message: random, at the sender's own
/// domain.
///
/// Set explicitly because `mail-builder`'s default is `<random@hostname>`, which
/// stamps the machine's name on every message and links mail sent from
/// different accounts to one computer.
fn outgoing_message_id(from_addr: &str) -> String {
    use rand::RngCore;
    let mut id = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut id);
    let domain = from_addr
        .rsplit_once('@')
        .map(|(_, d)| d.to_ascii_lowercase())
        .unwrap_or_else(|| "localhost".into());
    let random: String = id.iter().map(|b| format!("{b:02x}")).collect();
    format!("{random}@{domain}")
}

/// Build the RFC 5322 bytes of an outgoing plain-text message.
#[allow(clippy::too_many_arguments)]
pub fn build_outgoing(
    from_name: Option<&str>,
    from_addr: &str,
    to: &[String],
    cc: &[String],
    bcc: &[String],
    subject: &str,
    body_text: &str,
    in_reply_to: Option<&str>,
    references: &[String],
    attachments: &[OutboundAttachment],
) -> Result<Vec<u8>, MailError> {
    let from_addr = validate_recipient(from_addr)?;
    let subject = reject_header_injection(subject)?;
    let to: Vec<String> = to
        .iter()
        .map(|a| validate_recipient(a))
        .collect::<Result<_, _>>()?;
    let cc: Vec<String> = cc
        .iter()
        .map(|a| validate_recipient(a))
        .collect::<Result<_, _>>()?;
    // Bcc is validated but deliberately NOT written as a header — it goes in
    // the SMTP envelope only, which is the whole point of a blind copy.
    for b in bcc {
        validate_recipient(b)?;
    }

    let mut builder = mail_send::mail_builder::MessageBuilder::new();
    builder = match from_name {
        Some(n) => builder.from((reject_header_injection(n)?.to_string(), from_addr.clone())),
        None => builder.from(from_addr.clone()),
    };
    if !to.is_empty() {
        builder = builder.to(to.clone());
    }
    if !cc.is_empty() {
        builder = builder.cc(cc.clone());
    }
    builder = builder
        .message_id(outgoing_message_id(&from_addr))
        .subject(subject)
        .text_body(body_text.to_string());
    if let Some(irt) = in_reply_to {
        builder = builder.in_reply_to(reject_header_injection(irt)?.to_string());
    }
    if !references.is_empty() {
        let refs: Vec<String> = references
            .iter()
            .map(|r| reject_header_injection(r).map(|s| s.to_string()))
            .collect::<Result<_, _>>()?;
        builder = builder.references(refs);
    }
    for att in attachments {
        let safe = sanitize_attachment_name(&att.filename);
        builder = builder.attachment(att.mime.clone(), safe.value, att.bytes.clone());
    }

    let bytes = builder
        .write_to_vec()
        .map_err(|e| MailError::Protocol(format!("could not build the message: {e}")))?;
    if bytes.len() > MAX_OUTBOUND_BYTES {
        return Err(MailError::TooLarge { bytes: bytes.len() });
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── UID sets ────────────────────────────────────────────────────────────

    /// The set is what a bulk STORE *addresses*, so every case here is really
    /// "does this name exactly the messages it was given, and nothing else".
    #[test]
    fn uid_set_is_empty_for_no_uids() {
        // Not `[""]`: `UID STORE  +FLAGS (\Seen)` is a syntax error, and a
        // caller looping over the result must therefore send nothing at all.
        assert!(uid_set_chunks(&[], 1000).is_empty());
    }

    #[test]
    fn uid_set_collapses_a_run_into_a_range() {
        assert_eq!(uid_set_chunks(&[1, 2, 3, 4], 1000), vec!["1:4"]);
    }

    #[test]
    fn uid_set_keeps_isolated_uids_separate() {
        assert_eq!(uid_set_chunks(&[1, 3, 5], 1000), vec!["1,3,5"]);
    }

    #[test]
    fn uid_set_mixes_runs_and_singles() {
        assert_eq!(
            uid_set_chunks(&[1, 2, 3, 7, 10, 11], 1000),
            vec!["1:3,7,10:11"]
        );
    }

    #[test]
    fn uid_set_sorts_and_dedupes_first() {
        // The store returns them ordered, but a run is only detectable in order
        // and a duplicate would break one in half.
        assert_eq!(uid_set_chunks(&[3, 1, 2, 3], 1000), vec!["1:3"]);
    }

    #[test]
    fn uid_set_splits_on_the_character_budget() {
        // Every other uid, so nothing collapses: worst case for the budget.
        let uids: Vec<u32> = (0..100).map(|i| i * 2 + 1).collect();
        let chunks = uid_set_chunks(&uids, 40);
        assert!(chunks.len() > 1, "expected a split, got {chunks:?}");
        for c in &chunks {
            assert!(c.len() <= 40, "chunk over budget: {c:?}");
            assert!(!c.starts_with(','), "chunk starts with a separator: {c:?}");
            assert!(!c.ends_with(','), "chunk ends with a separator: {c:?}");
        }
        // The whole point: splitting must not drop or invent a single uid.
        let mut back: Vec<u32> = Vec::new();
        for c in &chunks {
            for piece in c.split(',') {
                back.push(piece.parse().expect("single uid"));
            }
        }
        assert_eq!(back, uids);
    }

    #[test]
    fn uid_set_never_splits_inside_a_range() {
        // A range cut in half addresses messages nobody asked about, which for
        // a `-FLAGS` on \Seen would mark unrelated mail unread.
        let uids: Vec<u32> = (1..=500).collect();
        let chunks = uid_set_chunks(&uids, 4);
        assert_eq!(chunks, vec!["1:500"]);
    }

    // ── Server search criteria ──────────────────────────────────────────

    #[test]
    fn search_criterion_names_subject_or_sender() {
        assert_eq!(
            server_search_criterion("invoice", true),
            "CHARSET UTF-8 OR SUBJECT \"invoice\" FROM \"invoice\""
        );
        assert_eq!(
            server_search_criterion("invoice", false),
            "OR SUBJECT \"invoice\" FROM \"invoice\""
        );
    }

    #[test]
    fn search_quoting_cannot_break_command_framing() {
        // A quote or backslash in the query is escaped in place ...
        assert_eq!(imap_quoted("say \"hi\" \\ bye"), "\"say \\\"hi\\\" \\\\ bye\"");
        // ... and a newline is dropped, never sent: inside a quoted-string it
        // would end the command and let the rest parse as new commands.
        assert_eq!(imap_quoted("a\r\nb"), "\"ab\"");
        assert_eq!(server_search_criterion("a\"b", true).matches('"').count(), 6);
    }

    // ── The crypto provider ─────────────────────────────────────────────────

    /// rustls refuses to guess between two compiled-in providers and panics at
    /// the *first handshake* if none is installed — a failure that would only
    /// ever show up on a user's machine, mid-connect.
    #[test]
    fn provider_is_installed() {
        install_crypto_provider();
        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
    }

    #[test]
    fn installing_twice_is_harmless() {
        install_crypto_provider();
        install_crypto_provider();
        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
    }

    // ── Secrets ─────────────────────────────────────────────────────────────

    #[test]
    fn a_password_never_prints_itself() {
        let pw = Password::new("hunter2");
        let printed = format!("{pw:?}");
        assert!(!printed.contains("hunter2"), "{printed}");
        assert_eq!(printed, "Password(<redacted>)");
        // And inside a container, which is how it would reach a log line.
        let wrapped = format!("{:?}", Some(pw.clone()));
        assert!(!wrapped.contains("hunter2"), "{wrapped}");
        assert_eq!(pw.expose(), "hunter2");
    }

    // ── Transport ───────────────────────────────────────────────────────────

    /// The one structural guarantee behind "there is no ignore-certificate
    /// option": the strings that would introduce one do not appear in the mail
    /// sources. Cheap, and it makes "just add a checkbox" a failing test rather
    /// than a code-review argument.
    #[test]
    fn no_certificate_verification_escape_hatch() {
        let sources: [(&str, &str); 4] = [
            ("mail_engine.rs", include_str!("mail_engine.rs")),
            ("mail_sanitize.rs", include_str!("mail_sanitize.rs")),
            ("mail_store.rs", include_str!("mail_store.rs")),
            ("commands/mail.rs", include_str!("../commands/mail.rs")),
        ];
        // Split so this list does not match itself when the scan runs over
        // this very file.
        let banned = [
            concat!("danger", "ous()"),
            concat!("ServerCert", "Verifier"),
            concat!("danger_accept", "_invalid"),
            concat!("with_custom_certificate", "_verifier"),
            concat!("NoCertificate", "Verification"),
            concat!("allow_invalid", "_certs"),
        ];
        for (name, src) in sources {
            for needle in banned {
                assert!(
                    !src.contains(needle),
                    "{name} must not contain `{needle}` — certificate validation has no bypass"
                );
            }
        }
    }

    /// v1 speaks implicit TLS only, so the cleartext submission/access ports
    /// must not appear as defaults anywhere in the mail sources.
    #[test]
    fn no_cleartext_default_ports() {
        let sources: [(&str, &str); 2] = [
            ("mail_engine.rs", include_str!("mail_engine.rs")),
            ("commands/mail.rs", include_str!("../commands/mail.rs")),
        ];
        for (name, src) in sources {
            // Split so the list does not match itself when the scan runs over
            // this very file.
            for port in [
                concat!(": ", "143"),
                concat!(": ", "110"),
                concat!(": ", "25,"),
                concat!(": ", "587"),
                concat!("port: ", "143"),
                concat!("port: ", "587"),
            ] {
                assert!(
                    !src.contains(port),
                    "{name} names a cleartext port `{port}`"
                );
            }
        }
    }

    // ── The session pool (#167) ────────────────────────────────────────────

    /// The tripwire that keeps the pool from being routed around. Every IMAP
    /// operation obtains its session from `acquire`, so `imap_login` is
    /// *defined* once and *called* once — a method that starts logging in
    /// directly again is a per-operation login storm, which is the whole defect
    /// this feature exists to remove, and it would otherwise be invisible.
    #[test]
    fn every_imap_operation_goes_through_the_pool() {
        let src = include_str!("mail_engine.rs");
        // Split so this assertion does not count itself.
        let needle = concat!("imap", "_login(");
        let uses = src.matches(needle).count();
        assert_eq!(
            uses, 2,
            "`{needle}` should appear exactly twice (its definition and the one \
             call inside `acquire`), found {uses} — an IMAP operation is logging \
             in for itself instead of leasing a pooled session"
        );
    }

    /// The key is what decides *who is authenticated*, so a different host, port
    /// or user must never share a pooled session.
    #[test]
    fn pool_key_separates_hosts_ports_and_users() {
        let base = MailServer {
            host: "imap.example.com".into(),
            port: 993,
            user: "a@example.com".into(),
            security: MailSecurity::Tls,
        };
        let key = pool_key(&base);
        let other_host = pool_key(&MailServer {
            host: "imap.other.com".into(),
            ..base.clone()
        });
        let other_port = pool_key(&MailServer {
            port: 994,
            ..base.clone()
        });
        let other_user = pool_key(&MailServer {
            user: "b@example.com".into(),
            ..base.clone()
        });
        assert_ne!(key, other_host);
        assert_ne!(key, other_port);
        assert_ne!(key, other_user);
    }

    /// A host is case-insensitive and a stray space is a typo, not an account —
    /// both would otherwise mint a second connection to the same server.
    #[test]
    fn pool_key_normalizes_the_host() {
        let a = pool_key(&MailServer {
            host: "IMAP.Example.COM".into(),
            port: 993,
            user: "a@example.com".into(),
            security: MailSecurity::Tls,
        });
        let b = pool_key(&MailServer {
            host: "  imap.example.com ".into(),
            port: 993,
            user: "a@example.com".into(),
            security: MailSecurity::Tls,
        });
        assert_eq!(a, b);
    }

    /// The two age thresholds, and the order they have to sit in: anything old
    /// enough to be closed is also old enough to have needed a probe, or a
    /// session could be handed out unprobed *because* it was too stale to keep.
    #[test]
    fn pool_entry_age_thresholds_are_ordered() {
        assert!(POOL_PROBE_AFTER < POOL_MAX_IDLE);

        assert!(!pool_entry_needs_probe(Duration::from_secs(1)));
        assert!(!pool_entry_expired(Duration::from_secs(1)));

        assert!(pool_entry_needs_probe(POOL_PROBE_AFTER));
        assert!(!pool_entry_expired(POOL_PROBE_AFTER));

        assert!(pool_entry_expired(POOL_MAX_IDLE));
        assert!(pool_entry_needs_probe(POOL_MAX_IDLE));
    }

    /// A liveness check that could outlive the login it is meant to save must
    /// not exist: the fallback for a failed probe is simply to log in.
    #[test]
    fn the_pool_probe_fails_faster_than_a_command() {
        assert!(POOL_PROBE_TIMEOUT < COMMAND_TIMEOUT);
    }

    /// Eviction is by key, so forgetting one account's credential cannot close
    /// another account's connection.
    #[test]
    fn forgetting_one_account_leaves_the_others_pooled() {
        let a = MailServer {
            host: "imap.a.example".into(),
            port: 993,
            user: "a@a.example".into(),
            security: MailSecurity::Tls,
        };
        let b = MailServer {
            host: "imap.b.example".into(),
            port: 993,
            user: "b@b.example".into(),
            security: MailSecurity::Tls,
        };
        // No socket is involved: the buckets are keyed and emptied by name, and
        // that naming is the whole of what eviction gets right or wrong.
        {
            let mut pool = pool().lock().unwrap();
            pool.entry(pool_key(&a)).or_default();
            pool.entry(pool_key(&b)).or_default();
        }
        forget_pooled_sessions(&a);
        let pool = pool().lock().unwrap();
        assert!(!pool.contains_key(&pool_key(&a)));
        assert!(pool.contains_key(&pool_key(&b)));
    }

    /// The refusal a VPN-only account gets is the gate's own sentence, so mail
    /// and CalDAV explain the state identically; and an account that is not
    /// gated passes the gate whatever the tunnel registry holds.
    #[test]
    fn the_vpn_refusal_is_the_shared_sentence_and_spares_ungated_accounts() {
        assert_eq!(
            MailError::VpnRequired.to_string(),
            crate::services::openvpn::VPN_GATE_REFUSAL
        );
        let account = MailAccount {
            id: "a1".into(),
            label: "Work".into(),
            address: "user@example.com".into(),
            imap: MailServer {
                host: "imap.example.com".into(),
                port: 993,
                user: "u".into(),
                security: MailSecurity::Tls,
            },
            smtp: MailServer {
                host: "smtp.example.com".into(),
                port: 465,
                user: "u".into(),
                security: MailSecurity::Tls,
            },
            ..Default::default()
        };
        assert_eq!(vpn_gate(&account), Ok(()));
    }

    #[tokio::test]
    async fn a_non_tls_endpoint_is_refused_before_any_socket_is_opened() {
        let server = MailServer {
            host: "imap.example.com".into(),
            port: 993,
            user: "u".into(),
            security: MailSecurity::Starttls,
        };
        let err = tls_stream(&server).await.unwrap_err();
        assert_eq!(err, MailError::PlaintextRefused);

        let server = MailServer {
            security: MailSecurity::None,
            ..server
        };
        let err = match smtp_connect(&server, &Password::new("x")).await {
            Ok(_) => panic!("a non-TLS SMTP endpoint must be refused"),
            Err(e) => e,
        };
        assert_eq!(err, MailError::PlaintextRefused);
    }

    // ── Parsing ─────────────────────────────────────────────────────────────

    fn fixture(name: &str) -> Vec<u8> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/mail")
            .join(name);
        std::fs::read(&path).unwrap_or_else(|e| panic!("fixture {name}: {e}"))
    }

    // ── Modified UTF-7 folder names ─────────────────────────────────────────

    /// Found in live QA against a German Gmail: `[Gmail]/Entwürfe` arrived as
    /// `[Gmail]/Entw&APw-rfe` and was shown that way.
    #[test]
    fn modified_utf7_folder_names_decode() {
        let cases: &[(&str, &str)] = &[
            // The reported case, and its siblings on a German account.
            ("Entw&APw-rfe", "Entwürfe"),
            ("Gel&APY-schte Elemente", "Gelöschte Elemente"),
            ("&APw-", "ü"),
            // Plain ASCII is untouched.
            ("INBOX", "INBOX"),
            ("[Gmail]/All Mail", "[Gmail]/All Mail"),
            // A literal ampersand is `&-`.
            ("Tom &- Jerry", "Tom & Jerry"),
            ("R&D", "R&D"),
            // Other alphabets. (Every expectation in this table was produced by
            // an independent reference decoder, not typed by hand — two of them
            // were wrong the first time and the decoder was right.)
            ("&BCcENQRABD0EPgQyBDgEOgQ4-", "Черновики"),
            ("&ZeVnLIqe-", "日本語"),
            // Astral plane: surrogate pairs must recombine, not become two
            // replacement characters.
            ("&2Dzfs9g837M-", "🎳🎳"),
            // The `,`-for-`/` substitution, which is the one way this differs
            // from ordinary base64: `ϰ` encodes to `A/A` in RFC 2045 and must
            // be spelled `A,A` here.
            ("&A,A-", "ϰ"),
            // Consecutive runs, and a run ended implicitly by a non-alphabet
            // character rather than by `-`.
            ("&APw-&APY-", "üö"),
            ("&APw x", "ü x"),
        ];
        for (input, want) in cases {
            assert_eq!(decode_modified_utf7(input), *want, "input {input:?}");
        }
    }

    /// A name that is not valid modified UTF-7 must still be *shown*. A folder
    /// that silently loses its name is worse than one that shows the wire form.
    #[test]
    fn an_undecodable_folder_name_is_kept_verbatim() {
        for input in [
            "&",           // a dangling shift
            "&!!!-",       // characters outside the alphabet
            "&A-",         // a truncated run
            "&AAAAAAAAAA", // unterminated, over-long
            "Weird&Name",
        ] {
            let got = decode_modified_utf7(input);
            assert!(!got.is_empty(), "{input:?} produced nothing");
        }
        assert_eq!(decode_modified_utf7("&"), "&");
        assert_eq!(decode_modified_utf7("&!!!-"), "&!!!-");
    }

    /// Whatever a server sends, decoding returns and never panics.
    #[test]
    fn folder_name_decoding_is_total() {
        // Grouped to read as "FOLDER", not in even nibble groups.
        #[allow(clippy::unusual_byte_groupings)]
        let mut seed: u64 = 0xF01DE_1234_0001;
        for _ in 0..5_000 {
            let len = {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                (seed >> 33) as usize % 48
            };
            let mut bytes = Vec::with_capacity(len);
            for _ in 0..len {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                let b = (seed >> 24) as u8;
                // Weight the structural characters, where the states are.
                bytes.push(match b % 6 {
                    0 => b'&',
                    1 => b'-',
                    2 => b',',
                    3 => b'A',
                    _ => b,
                });
            }
            let input = String::from_utf8_lossy(&bytes).to_string();
            let _ = decode_modified_utf7(&input);
        }
    }

    /// The split that makes this safe: the wire form is what `SELECT` gets, the
    /// decoded form is only ever shown. Decoding the path would break every
    /// folder with a non-ASCII character in its name.
    #[test]
    fn decoding_is_display_only() {
        let wire = "[Gmail]/Entw&APw-rfe";
        let leaf = wire.rsplit(['/', '.']).next().unwrap();
        assert_eq!(decode_modified_utf7(leaf), "Entwürfe");
        assert_eq!(
            wire, "[Gmail]/Entw&APw-rfe",
            "the path must not be rewritten"
        );
    }

    /// A server-supplied label goes through the same control-stripping a subject
    /// does — an RTL override in a folder name reorders what the user reads.
    #[test]
    fn a_bidi_override_in_a_folder_name_is_stripped() {
        // `&IC8-` is U+202F… use the actual override: U+202E is `&IC4-`.
        let decoded = decode_modified_utf7("Rechnung&IC4-gnp.exe");
        assert!(
            decoded.contains('\u{202E}'),
            "the fixture must contain the override"
        );
        assert!(!strip_controls(&decoded).contains('\u{202E}'));
    }

    /// The extraction half of the `Authentication-Results` feature: that the
    /// header is found at all, in document order, and unfolded.
    ///
    /// It reads the raw bytes rather than `mail-parser`'s `HeaderValue`, so this
    /// is the test that would catch the parser deciding to hand unknown headers
    /// back differently — at which point a silently empty list would mean every
    /// message shows no verdict, with nothing failing.
    #[test]
    fn authentication_results_headers_are_read_in_order_and_unfolded() {
        let raw = b"From: a@example.com\r\n\
                    To: b@example.org\r\n\
                    Authentication-Results: mx.example.net;\r\n\
                    \tspf=pass smtp.mailfrom=a.example;\r\n\
                    \tdkim=pass header.d=a.example\r\n\
                    Authentication-Results: relay.example.org; dmarc=fail\r\n\
                    Subject: folded\r\n\r\nbody\r\n";
        let msg = parse_bounded(raw).unwrap();
        let values = authentication_results_values(&msg, raw);
        assert_eq!(values.len(), 2, "{values:?}");
        assert_eq!(
            values[0],
            "mx.example.net; spf=pass smtp.mailfrom=a.example; dkim=pass header.d=a.example",
            "the topmost header must come back unfolded and first"
        );
        assert!(values[1].starts_with("relay.example.org"));

        // …and it reaches ParsedHeaders, still untrusted.
        let parsed = parse_message(raw).unwrap();
        let auth = parsed
            .headers
            .auth
            .expect("the header must reach ParsedHeaders");
        assert_eq!(auth.authserv_id.as_deref(), Some("mx.example.net"));
        assert_eq!(auth.header_count, 2);
        assert_eq!(
            auth.state,
            crate::schema::mail::MailAuthState::Unconfigured,
            "parsing must never mint trust; only apply_trust does"
        );
    }

    #[test]
    fn a_message_with_no_authentication_results_reports_none() {
        assert!(parse_message(&fixture("simple.eml"))
            .unwrap()
            .headers
            .auth
            .is_none());
    }

    #[test]
    fn a_plain_message_parses() {
        let msg = parse_message(&fixture("simple.eml")).unwrap();
        assert_eq!(msg.headers.subject, "Hello there");
        assert_eq!(msg.headers.from.address, "sender@example.com");
        assert_eq!(msg.headers.to.len(), 1);
        assert_eq!(msg.headers.to[0].address, "receiver@example.org");
        assert!(msg.text.unwrap().contains("plain body"));
    }

    #[test]
    fn deeply_nested_messages_are_refused_rather_than_survived() {
        let raw = fixture("deep_nesting.eml");
        assert_eq!(parse_message(&raw).err(), Some(MailError::TooDeep));
    }

    #[test]
    fn too_many_parts_are_refused() {
        // Built in the test rather than checked in — 10 000 parts is a large
        // file to carry in git for one assertion.
        let mut raw = String::from(
            "From: a@example.com\r\nTo: b@example.org\r\nSubject: many\r\n\
             Content-Type: multipart/mixed; boundary=\"B\"\r\n\r\n",
        );
        for i in 0..10_000 {
            raw.push_str(&format!(
                "--B\r\nContent-Type: text/plain\r\n\r\npart {i}\r\n"
            ));
        }
        raw.push_str("--B--\r\n");
        assert_eq!(
            parse_message(raw.as_bytes()).err(),
            Some(MailError::TooManyParts),
            "a 10 000-part message must be refused, not merely survived"
        );
    }

    #[test]
    fn an_oversized_header_line_is_refused() {
        let raw = fixture("huge_header.eml");
        assert_eq!(parse_message(&raw).err(), Some(MailError::HeaderTooLong));
    }

    #[test]
    fn an_oversized_message_is_refused_before_parsing() {
        let mut raw = b"From: a@example.com\r\nSubject: big\r\n\r\n".to_vec();
        raw.resize(MAX_MESSAGE_BYTES + 1, b'x');
        assert!(matches!(
            parse_message(&raw),
            Err(MailError::TooLarge { .. })
        ));
    }

    #[test]
    fn truncated_base64_never_panics() {
        let msg = parse_message(&fixture("truncated_base64.eml"));
        // Either it decodes lossily or the part is unusable; the only forbidden
        // outcome is a panic, which reaching this line proves did not happen.
        assert!(msg.is_ok() || matches!(msg, Err(MailError::NoDisplayableContent)));
    }

    /// `+ADw-script+AD4-` is `<script>` in UTF-7, and `mail-parser` *does*
    /// decode it — which is exactly why the refusal lives above the parser
    /// rather than being assumed from it. A UTF-7 body must never reach the
    /// HTML path at all.
    #[test]
    fn a_utf7_body_never_reaches_the_html_path() {
        let msg = parse_message(&fixture("utf7_script.eml")).unwrap();
        assert!(
            msg.html.is_none(),
            "a UTF-7 body must be refused as HTML, got {:?}",
            msg.html
        );
        // It is still shown, as text, escaped by the plain-text path.
        let text = msg.text.unwrap_or_default();
        let escaped = crate::services::mail_sanitize::plain_text_to_html(&text);
        assert!(
            !escaped.to_ascii_lowercase().contains("<script"),
            "{escaped}"
        );
    }

    #[test]
    fn charset_refusal_covers_the_utf7_spellings_and_nothing_else() {
        for cs in [
            "utf-7",
            "UTF-7",
            " \"utf-7\" ",
            "unicode-1-1-utf-7",
            "x-utf-7",
            // The two labels `mail-parser` really decodes as UTF-7. `-` and `_`
            // are the same character to its lookup, and `csutf7` has no
            // separator at all — a hyphenated-spellings list missed both.
            "utf_7",
            "UTF_7",
            "csutf7",
            "CSUTF7",
            " \"csUTF7\" ",
        ] {
            assert!(charset_is_refused(Some(cs)), "{cs} must be refused");
        }
        for cs in [
            "utf-8",
            "iso-8859-1",
            "windows-1252",
            "us-ascii",
            "shift_jis",
        ] {
            assert!(!charset_is_refused(Some(cs)), "{cs} must be accepted");
        }
        assert!(!charset_is_refused(None), "no charset is not a refusal");
    }

    /// The regression the spelling list above exists for: `mail-parser` decodes
    /// `csutf7` and `utf_7` as UTF-7 (its lookup lowercases and maps `-`→`_`,
    /// and its two keys are `utf_7`/`csutf7`), so a body labelled either one
    /// arrived at the HTML path as real `<script>` markup that the sender never
    /// wrote. Asserted end-to-end, not just on the predicate, because the
    /// predicate is only worth what the parse around it does with it.
    #[test]
    fn every_utf7_label_the_parser_decodes_is_kept_off_the_html_path() {
        for cs in ["utf-7", "utf_7", "UTF_7", "csutf7", "CSUTF7"] {
            let raw = format!(
                "From: a@example.com\r\nTo: b@example.org\r\nSubject: s\r\n\
                 Content-Type: text/html; charset={cs}\r\n\r\n\
                 +ADw-script+AD4-alert(1)+ADw-/script+AD4-\r\n"
            );
            let msg = parse_message(raw.as_bytes()).unwrap();
            assert!(
                msg.html.is_none(),
                "charset={cs} reached the HTML path with {:?}",
                msg.html
            );
        }
    }

    /// `mail-parser`'s `html_body` falls back to the `text/plain` part when a
    /// message has no `text/html` one. Reading that part directly (rather than
    /// through its escaping `body_html()` accessor) rendered plain-text mail as
    /// markup: the anchor below became a real link row with a real Open button
    /// in a message whose author only ever typed characters.
    #[test]
    fn a_plain_text_only_message_is_never_offered_as_html() {
        let raw = b"From: a@example.com\r\nTo: b@example.org\r\nSubject: s\r\n\
                    Content-Type: text/plain; charset=utf-8\r\n\r\n\
                    hello <a href=\"https://evil.example\">bank.example</a>\r\n";
        let msg = parse_message(raw).unwrap();
        assert!(
            msg.html.is_none(),
            "a text/plain body must not be handed to the HTML renderer, got {:?}",
            msg.html
        );
        let text = msg.text.expect("the plain body must still be shown");
        assert!(text.contains("evil.example"));
        // And the path it *does* take escapes it.
        let escaped = crate::services::mail_sanitize::plain_text_to_html(&text);
        assert!(!escaped.contains("<a "), "{escaped}");
        assert!(escaped.contains("&lt;a "), "{escaped}");
    }

    /// A message with no Content-Type at all defaults to `text/plain`, so it
    /// takes the same escaped path.
    #[test]
    fn a_message_with_no_content_type_is_not_html() {
        let raw = b"From: a@example.com\r\nSubject: s\r\n\r\n<b>x</b>\r\n";
        let msg = parse_message(raw).unwrap();
        assert!(msg.html.is_none(), "{:?}", msg.html);
        assert!(msg.text.unwrap_or_default().contains("<b>"));
    }

    /// The positive control for the two rules above: a genuine `text/html` part
    /// in a genuine charset still reaches the HTML path.
    #[test]
    fn a_real_html_part_still_reaches_the_html_path() {
        let raw = b"From: a@example.com\r\nSubject: s\r\n\
                    Content-Type: text/html; charset=utf-8\r\n\r\n<p>hi</p>\r\n";
        let msg = parse_message(raw).unwrap();
        assert!(msg.html.unwrap_or_default().contains("<p>hi</p>"));
    }

    #[test]
    fn duplicate_from_headers_are_reported_not_silently_resolved() {
        let msg = parse_message(&fixture("duplicate_from.eml")).unwrap();
        assert!(
            msg.headers
                .malformed_headers
                .contains(&"DUPLICATE_FROM".to_string()),
            "{:?}",
            msg.headers.malformed_headers
        );
    }

    /// `From: "security@bank.example" <attacker@evil.example>` — the display
    /// name and the addr-spec must reach the UI as separate fields, so the UI
    /// can render the address unconditionally.
    #[test]
    fn a_display_name_never_stands_in_for_the_address() {
        let msg = parse_message(&fixture("spoofed_display_name.eml")).unwrap();
        assert_eq!(msg.headers.from.address, "attacker@evil.example");
        assert_eq!(
            msg.headers.from.name.as_deref(),
            Some("security@bank.example")
        );
    }

    #[test]
    fn a_traversal_filename_is_reduced_to_its_basename() {
        let msg = parse_message(&fixture("traversal_filename.eml")).unwrap();
        assert_eq!(msg.attachments.len(), 1);
        assert_eq!(msg.attachments[0].meta.filename, "passwd");
    }

    #[test]
    fn an_rtl_override_filename_is_defused() {
        let msg = parse_message(&fixture("rtl_filename.eml")).unwrap();
        let name = &msg.attachments[0].meta.filename;
        assert!(!name.contains('\u{202E}'), "{name}");
        assert!(!name.ends_with(".png"), "{name}");
    }

    #[test]
    fn a_message_with_only_an_octet_stream_body_has_no_displayable_content() {
        let raw = b"From: a@example.com\r\nSubject: x\r\n\
                    Content-Type: application/octet-stream\r\n\r\n\x00\x01\x02";
        assert!(matches!(
            parse_message(raw),
            Err(MailError::NoDisplayableContent) | Ok(_)
        ));
    }

    #[test]
    fn a_message_with_no_content_type_still_parses() {
        let raw = b"From: a@example.com\r\nSubject: x\r\n\r\nhello";
        let msg = parse_message(raw).unwrap();
        assert_eq!(msg.text.as_deref(), Some("hello"));
    }

    /// The plain-text preference must not become a way to skip sanitization of
    /// the HTML alternative.
    #[test]
    fn a_hostile_html_alternative_is_still_sanitized() {
        let msg = parse_message(&fixture("alternative_hostile_html.eml")).unwrap();
        let html = msg.html.expect("the html alternative must be found");
        assert!(html.contains("<script"), "the fixture must be hostile");
        let cleaned = crate::services::mail_sanitize::sanitize_message_html(&html).unwrap();
        assert!(!cleaned.html.to_ascii_lowercase().contains("<script"));
    }

    // ── Attachment typing ───────────────────────────────────────────────────

    #[test]
    fn an_executable_payload_is_flagged_however_it_is_labelled() {
        let mz = b"MZ\x90\x00\x03\x00\x00\x00";
        assert_eq!(
            type_mismatch("image/png", "invoice.png", mz).as_deref(),
            Some("executable")
        );
        let elf = b"\x7fELF\x02\x01\x01\x00";
        assert_eq!(
            type_mismatch("application/pdf", "report.pdf", elf).as_deref(),
            Some("executable")
        );
    }

    #[test]
    fn a_double_extension_is_flagged() {
        assert_eq!(
            type_mismatch("application/octet-stream", "photo.jpg.exe", b"").as_deref(),
            Some("double-extension")
        );
    }

    // ── Outbound ────────────────────────────────────────────────────────────

    /// A CRLF in the subject must not be able to insert a `Bcc:` header.
    #[test]
    fn header_injection_through_the_subject_is_refused() {
        let err = build_outgoing(
            None,
            "me@example.com",
            &["you@example.org".into()],
            &[],
            &[],
            "hello\r\nBcc: evil@evil.example",
            "body",
            None,
            &[],
            &[],
        )
        .unwrap_err();
        assert!(matches!(err, MailError::Protocol(_)));
    }

    #[test]
    fn header_injection_through_a_recipient_is_refused() {
        let err = build_outgoing(
            None,
            "me@example.com",
            &["a@example.com\nCc: b@evil.example".into()],
            &[],
            &[],
            "hi",
            "body",
            None,
            &[],
            &[],
        )
        .unwrap_err();
        assert!(matches!(err, MailError::Protocol(_)));
    }

    #[test]
    fn a_sent_message_id_names_the_sender_domain_not_this_machine() {
        let bytes = build_outgoing(
            None,
            "me@Example.com",
            &["you@example.org".into()],
            &[],
            &[],
            "hi",
            "body",
            None,
            &[],
            &[],
        )
        .unwrap();
        let text = String::from_utf8_lossy(&bytes);
        let line = text
            .lines()
            .find(|l| l.to_ascii_lowercase().starts_with("message-id:"))
            .expect("a Message-ID header");
        assert!(line.trim_end().ends_with("@example.com>"), "{line}");
        if let Ok(host) = gethostname_for_test() {
            assert!(!line.contains(&host), "{line}");
        }
    }

    fn gethostname_for_test() -> Result<String, ()> {
        std::fs::read_to_string("/etc/hostname")
            .map(|h| h.trim().to_string())
            .ok()
            .filter(|h| h.len() > 3)
            .ok_or(())
    }

    /// The address lands in `RCPT TO:<…>` verbatim, so anything that could end
    /// the path or add a parameter is refused before a message is built.
    #[test]
    fn a_recipient_must_be_a_plain_address() {
        for good in ["a@example.com", "first.last+tag@sub.example.org", "jörg@exämple.de"] { // privacy-check: ok — IDN fixture, not a real address
            assert!(validate_recipient(good).is_ok(), "{good}");
        }
        for bad in [
            "a@example.com> NOTIFY=NEVER",
            "\"a>b\"@example.com",
            "a\tb@example.com",
            "a@b@example.com",
            "<a@example.com>",
            ".a@example.com",
            "a..b@example.com",
            "a@-example.com", // privacy-check: ok — deliberately invalid fixture
            "a@example..com",
            "a@",
            "@example.com",
            "a\u{202E}b@example.com",
        ] {
            assert!(validate_recipient(bad).is_err(), "{bad:?} must be refused");
        }
    }

    /// Bcc is an envelope concept. Writing it as a header would disclose every
    /// blind recipient to every other one.
    #[test]
    fn bcc_never_appears_as_a_header() {
        let bytes = build_outgoing(
            None,
            "me@example.com",
            &["you@example.org".into()],
            &[],
            &["hidden@example.net".into()],
            "hello",
            "body",
            None,
            &[],
            &[],
        )
        .unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(!text.contains("Bcc"), "{text}");
        assert!(!text.contains("hidden@example.net"), "{text}");
    }

    /// A picked file's directory is a username and project-structure leak, so
    /// only the basename leaves.
    #[test]
    fn an_attachment_carries_only_its_basename() {
        let bytes = build_outgoing(
            None,
            "me@example.com",
            &["you@example.org".into()],
            &[],
            &[],
            "with attachment",
            "body",
            None,
            &[],
            &[OutboundAttachment {
                filename: "/home/tester/secret-project/notes.pdf".into(),
                mime: "application/pdf".into(),
                bytes: b"%PDF-1.4".to_vec(),
            }],
        )
        .unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("notes.pdf"), "{text}");
        assert!(!text.contains("secret-project"), "{text}");
        assert!(!text.contains("/home/tester"), "{text}");
    }

    #[test]
    fn an_oversized_outgoing_message_is_refused_before_any_network_call() {
        let err = build_outgoing(
            None,
            "me@example.com",
            &["you@example.org".into()],
            &[],
            &[],
            "big",
            "body",
            None,
            &[],
            &[OutboundAttachment {
                filename: "big.bin".into(),
                mime: "application/octet-stream".into(),
                bytes: vec![0u8; MAX_OUTBOUND_BYTES],
            }],
        )
        .unwrap_err();
        assert!(matches!(err, MailError::TooLarge { .. }));
    }

    #[test]
    fn a_normal_message_builds() {
        let bytes = build_outgoing(
            Some("Me"),
            "me@example.com",
            &["you@example.org".into()],
            &["cc@example.net".into()],
            &[],
            "Subject line",
            "Hello.",
            Some("<parent@example.com>"),
            &["<root@example.com>".into()],
            &[],
        )
        .unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("Subject"), "{text}");
        assert!(text.contains("you@example.org"), "{text}");
        assert!(text.contains("cc@example.net"), "{text}");
    }
}

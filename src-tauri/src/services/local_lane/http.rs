//! The little HTTP/1.1 the lane speaks: a strict request parser, the request
//! it sends on, and the response head it passes back. Pure over bytes, so the
//! parts that decide what passes are unit tests.
//!
//! One request per connection, always: the lane answers `Connection: close`.
//! It takes a `Content-Length` body and nothing else (no chunked request, no
//! upgrade, no compression), so what it judged is exactly what goes upstream:
//! it never forwards the client's bytes, it builds the request again from the
//! parts it parsed.

use super::policy::{reason, Refusal};

/// The most header bytes read before the request is refused.
pub const MAX_HEAD: usize = 32 * 1024;
const MAX_HEADERS: usize = 100;
const MAX_TARGET: usize = 4096;

/// A request head, parsed.
#[derive(Debug, PartialEq, Eq)]
pub struct Head {
    pub method: String,
    pub target: String,
    pub headers: Vec<(String, String)>,
    /// `Content-Length`, when the request has one.
    pub length: Option<usize>,
    pub expects_continue: bool,
}

impl Head {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

/// Where the head ends in `buf` (the index just past the blank line).
pub fn head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4)
}

fn token_ok(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
}

fn bad(msg: &str) -> Refusal {
    Refusal::new(400, msg)
}

/// Parse the head of a request (`bytes` ends at the blank line). Refuses what
/// the lane will not carry: a malformed line, a bare line feed, a folded or
/// repeated length, `Transfer-Encoding`, `Upgrade`, a content encoding, an
/// expectation other than `100-continue`, and a body larger than `max_body`.
pub fn parse_head(bytes: &[u8], max_body: usize) -> Result<Head, Refusal> {
    let text = std::str::from_utf8(bytes).map_err(|_| bad("The request head is not text."))?;
    if text.bytes().any(|b| b == 0) || text.replace("\r\n", "").contains(['\r', '\n']) {
        return Err(bad("The request head has a bare line break."));
    }
    let mut lines = text.split("\r\n");
    let first = lines.next().unwrap_or("");
    let mut parts = first.split(' ');
    let (Some(method), Some(target), Some(version), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else {
        return Err(bad("The request line is malformed."));
    };
    if !token_ok(method) || !method.bytes().all(|b| b.is_ascii_uppercase()) || method.len() > 16 {
        return Err(bad("The request method is malformed."));
    }
    if target.is_empty() || target.len() > MAX_TARGET || target.bytes().any(|b| b <= b' ' || b == 0x7f) {
        return Err(bad("The request target is malformed."));
    }
    if version != "HTTP/1.1" && version != "HTTP/1.0" {
        return Err(Refusal::new(400, "Only HTTP/1.0 and HTTP/1.1 are spoken here."));
    }
    let mut headers = Vec::new();
    for line in lines.take_while(|l| !l.is_empty()) {
        if headers.len() >= MAX_HEADERS {
            return Err(Refusal::new(431, "Too many request headers."));
        }
        if line.starts_with([' ', '\t']) {
            return Err(bad("A folded header line is not accepted."));
        }
        let (name, value) = line.split_once(':').ok_or_else(|| bad("A header line has no colon."))?;
        if !token_ok(name) {
            return Err(bad("A header name is malformed."));
        }
        headers.push((name.to_string(), value.trim_matches([' ', '\t']).to_string()));
    }
    let mut head = Head { method: method.to_string(), target: target.to_string(), headers, length: None, expects_continue: false };
    let mut lengths = head.headers.iter().filter(|(k, _)| k.eq_ignore_ascii_case("content-length")).map(|(_, v)| v.as_str());
    if let Some(first) = lengths.next() {
        if lengths.any(|other| other != first) {
            return Err(bad("Content-Length is given twice."));
        }
        if first.is_empty() || !first.bytes().all(|b| b.is_ascii_digit()) || first.len() > 12 {
            return Err(bad("Content-Length is not a number."));
        }
        head.length = Some(first.parse().map_err(|_| bad("Content-Length is not a number."))?);
    }
    if head.header("transfer-encoding").is_some() {
        return Err(Refusal::new(411, "A chunked request body is not accepted here; send a Content-Length."));
    }
    if head.header("upgrade").is_some() || head.header("connection").is_some_and(|c| c.to_ascii_lowercase().contains("upgrade")) {
        return Err(bad("An upgrade is not carried here."));
    }
    if head.header("content-encoding").is_some_and(|e| !e.eq_ignore_ascii_case("identity")) {
        return Err(bad("A compressed request body is not accepted here."));
    }
    if let Some(expect) = head.header("expect") {
        if !expect.eq_ignore_ascii_case("100-continue") {
            return Err(Refusal::new(417, "Only 100-continue is understood as an expectation."));
        }
        head.expects_continue = true;
    }
    if head.length.is_some_and(|n| n > max_body) {
        return Err(Refusal::new(413, format!("The request body is larger than the {} MiB this lane carries.", max_body / (1024 * 1024))));
    }
    Ok(head)
}

/// Decode a chunked body held whole, or `None` when it is malformed or has
/// more bytes than `cap` after decoding.
pub fn dechunk(mut raw: &[u8], cap: usize) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let eol = raw.windows(2).position(|w| w == b"\r\n")?;
        let size_text = std::str::from_utf8(&raw[..eol]).ok()?;
        let size = usize::from_str_radix(size_text.split(';').next()?.trim(), 16).ok()?;
        raw = &raw[eol + 2..];
        if size == 0 {
            return Some(out);
        }
        if out.len().checked_add(size)? > cap || raw.len() < size + 2 || &raw[size..size + 2] != b"\r\n" {
            return None;
        }
        out.extend_from_slice(&raw[..size]);
        raw = &raw[size + 2..];
    }
}

/// The request sent upstream: the line, the headers `keep` lets through and a
/// `Host` of the lane's own choosing, `Connection: close`, and a length that is
/// the body's. The client's `Host`, `Connection`, `Content-Length` and every
/// header not named in `keep` are not copied.
pub fn upstream_request(method: &str, path: &str, host: &str, head: &Head, keep: &[&str], body: &[u8]) -> Vec<u8> {
    // Identity only: a filtered list is read and rewritten, so it must not be compressed.
    let mut out = format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\nAccept-Encoding: identity\r\n");
    for (name, value) in &head.headers {
        if keep.iter().any(|k| k.eq_ignore_ascii_case(name)) && !name.eq_ignore_ascii_case("accept-encoding") && !value.contains(['\r', '\n']) {
            out.push_str(&format!("{name}: {value}\r\n"));
        }
    }
    if !body.is_empty() || method == "POST" {
        out.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    out.push_str("Connection: close\r\n\r\n");
    let mut bytes = out.into_bytes();
    bytes.extend_from_slice(body);
    bytes
}

/// An upstream response head, parsed.
#[derive(Debug, PartialEq, Eq)]
pub struct ResponseHead {
    pub status: u16,
    pub line: String,
    pub headers: Vec<(String, String)>,
}

impl ResponseHead {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
    pub fn chunked(&self) -> bool {
        self.header("transfer-encoding").is_some_and(|t| t.to_ascii_lowercase().contains("chunked"))
    }
}

/// Parse the head of an upstream response (`bytes` ends at the blank line).
pub fn parse_response_head(bytes: &[u8]) -> Result<ResponseHead, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "the response head is not text".to_string())?;
    let mut lines = text.split("\r\n");
    let line = lines.next().unwrap_or("").to_string();
    let mut parts = line.splitn(3, ' ');
    let (Some(version), Some(status)) = (parts.next(), parts.next()) else { return Err("the status line is malformed".into()) };
    if !version.starts_with("HTTP/1.") {
        return Err("the status line is malformed".into());
    }
    let status: u16 = status.parse().map_err(|_| "the status is not a number".to_string())?;
    let headers = lines
        .take_while(|l| !l.is_empty())
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.to_string(), v.trim().to_string()))
        .collect();
    Ok(ResponseHead { status, line, headers })
}

/// The head passed back to the client: the status line and every header but the
/// connection-management ones, then `Connection: close`. The body framing
/// (`Content-Length`, `Transfer-Encoding`) is kept: the body is passed on as it
/// came.
pub fn passthrough_head(head: &ResponseHead) -> Vec<u8> {
    const DROP: &[&str] = &["connection", "keep-alive", "proxy-connection", "proxy-authenticate", "upgrade", "trailer", "te"];
    let mut out = format!("{}\r\n", head.line);
    for (name, value) in &head.headers {
        if !DROP.iter().any(|d| d.eq_ignore_ascii_case(name)) && !value.contains(['\r', '\n']) {
            out.push_str(&format!("{name}: {value}\r\n"));
        }
    }
    out.push_str("Connection: close\r\n\r\n");
    out.into_bytes()
}

/// A whole response the lane makes up itself (a refusal, a filtered list).
pub fn response(status: u16, content_type: &str, body: &[u8]) -> Vec<u8> {
    let mut out = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        reason(status),
        body.len()
    )
    .into_bytes();
    out.extend_from_slice(body);
    out
}

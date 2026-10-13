//! CalDAV (RFC 4791 + RFC 6578) — the transport half, hand-rolled on `reqwest`.
//!
//! `docs/caldav_plan.md` §"Dependency decision" is why there is no CalDAV crate
//! here: the whole protocol surface this feature needs is six fixed XML request
//! bodies and one response document shape. The bodies are string templates (the
//! way `src/lib/calendar/ics.ts` builds ICS text); the responses go through `roxmltree`,
//! the one new dependency, because a `multistatus` is real XML with namespaces
//! and parsing it by hand is how a client starts believing `<D:href>` and
//! `<d:href>` are different elements.
//!
//! **What this module does not do is understand iCalendar.** A `multistatus`
//! carries `calendar-data` as opaque text; that text is handed to the frontend
//! and parsed by `src/lib/calendar/ics.ts`, which is the one parser in this codebase that
//! knows about folding, escaping, `RRULE` and `VALARM`, and the one with tests
//! for all four. This module's entire job is "speak WebDAV, hand back text".
//!
//! **Deliberately not routed through `browser_engine`'s SSRF machinery**
//! (`reader_hop_allowed` / `resolve_hop` / DNS pinning). That machinery exists
//! because a reader-mode or ICS-subscribe URL is content *someone else* handed
//! the user and may point anywhere, including at a metadata endpoint. A CalDAV
//! base URL is the opposite case — the user typed it, for an account they are
//! setting up on purpose — and is exactly the posture `MailServer.host` already
//! has: mail does not run its IMAP host past the reader's hop judge either.
//! Someone pointing this at `https://localhost:5232` for a self-hosted Radicale
//! is not an attack. Redirects are still capped ([`MAX_REDIRECTS`]) so a
//! misconfigured or looping server cannot spin the client forever, and the body
//! is capped so a "calendar" cannot be used to exhaust memory.
//!
//! TLS is the same `rustls` + OS-trust-store stack mail and the browser reader
//! use, with **no cert-ignore escape hatch** — a self-signed cert on a
//! self-hosted server is fixed in the machine's trust store, not by a checkbox.

use std::time::Duration;

use reqwest::{Method, StatusCode, Url};
use roxmltree::Document;

use crate::schema::caldav::{CalDavChanges, CalDavCollection, CalDavResource, CalDavWrite};

// ── Namespaces ──────────────────────────────────────────────────────────────

pub const NS_DAV: &str = "DAV:";
pub const NS_CALDAV: &str = "urn:ietf:params:xml:ns:caldav";
/// `getctag` — Apple's calendar-server extension. Unstandardized and universal:
/// the cheap "did anything in this collection change" string every server that
/// predates RFC 6578 still answers with.
pub const NS_CALSERVER: &str = "http://calendarserver.org/ns/";
/// `calendar-color` — the other de-facto Apple property.
pub const NS_APPLE: &str = "http://apple.com/ns/ical/";

// ── Limits ──────────────────────────────────────────────────────────────────

/// One request's whole lifetime. Generous because a first `calendar-query` over
/// a decade of events on a slow institutional server is a real wait, bounded
/// because a scheduled sync must not be able to pile up forever.
const CALDAV_TIMEOUT: Duration = Duration::from_secs(45);

/// Largest response body read. A year of a busy calendar is a few hundred KB;
/// this is generous while still bounding what an unattended sync can pull into
/// memory.
const MAX_BODY: usize = 32 * 1024 * 1024;

/// Redirect hops followed. `.well-known/caldav` bouncing to the real base path
/// is normal and expected — a chain longer than this is a misconfiguration.
const MAX_REDIRECTS: usize = 5;

/// `calendar-multiget` batch size, so a collection with thousands of changed
/// resources does not become one enormous request body.
const MULTIGET_CHUNK: usize = 50;

const USER_AGENT: &str = concat!(crate::app_name!(), "-CalDAV/1.0");

// ── Credentials ─────────────────────────────────────────────────────────────

/// A CalDAV login. Basic Auth over TLS is what nearly every non-SSO CalDAV
/// endpoint speaks; increasingly the password is an app-specific one minted in
/// the provider's own settings rather than the account's primary password (the
/// setup dialog says so without assuming it).
///
/// `origin` is the **fixed credential origin** (gap 26): the account's
/// normalized `base_url`, or during discovery the URL the user typed. Every hop
/// of every request is judged against it by [`credentials_may_follow`] — never
/// against the URL being requested, which for a stored collection or resource
/// href is a string the *server* chose. Built only through [`Credentials::new`],
/// which refuses `http://` (decision E2b).
#[derive(Clone)]
pub struct Credentials {
    pub user: String,
    pub password: String,
    pub origin: Url,
}

impl Credentials {
    /// A login whose credentials may only go where `base_url` names. Refuses a
    /// `http://` base URL with [`HTTP_REFUSED`].
    pub fn new(user: String, password: String, base_url: &str) -> Result<Self, String> {
        let origin = normalize_base_url(base_url)?;
        Ok(Self {
            user,
            password,
            origin,
        })
    }
}

impl std::fmt::Debug for Credentials {
    /// Never print the password. A `{:?}` in an error path is how a secret ends
    /// up in a log file.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credentials")
            .field("user", &self.user)
            .field("password", &"<redacted>")
            .field("origin", &self.origin.as_str())
            .finish()
    }
}

/// The fixed code every refusal of plain `http://` CalDAV starts with
/// (decision E2b). The frontend maps it to one translated sentence saying why
/// (`caldav.httpRefused`); the English text after it is the detail.
pub const HTTP_REFUSED: &str = "caldav_http_refused";

fn http_refused(detail: &str) -> String {
    format!(
        "{HTTP_REFUSED}: CalDAV needs https:// — over http:// the password and the calendar \
         would cross the network in the clear ({detail})"
    )
}

/// A request aimed at an address outside the credential origin, refused before
/// anything is sent. Recoverable, and the sentence says how.
fn off_origin(url: &Url, origin: &Url) -> String {
    format!(
        concat!(
            "the server named {} for this account, outside the address the account uses ({}). ",
            crate::app_name!(),
            " only sends CalDAV credentials to that address (or another HTTPS host under its \
             domain) — if you trust {}, set the account's server URL to it."
        ),
        url.host_str().unwrap_or("another host"),
        origin.host_str().unwrap_or("its server"),
        url.host_str().unwrap_or("that host"),
    )
}

/// Whether `href` may be requested with `cred` — the check every server-named
/// href (principal, home set, collection, resource) passes before it is used or
/// stored. `http:` is never inside an origin (E2b).
pub fn href_in_origin(origin: &Url, href: &str) -> bool {
    Url::parse(href)
        .map(|u| u.scheme() == "https" && credentials_may_follow(origin, &u))
        .unwrap_or(false)
}

/// The `https://` twin of a **same-host** `http://` href, on the origin's port —
/// what an account switched from `http://` to `https://` keeps of its old
/// calendar subscriptions and resource addresses (E2b left them unusable).
/// `None` for anything else: another host, another scheme, an `http` origin.
pub fn https_twin(href: &str, origin: &Url) -> Option<String> {
    if origin.scheme() != "https" {
        return None;
    }
    let mut url = Url::parse(href).ok()?;
    if url.scheme() != "http" || !url.host_str()?.eq_ignore_ascii_case(origin.host_str()?) {
        return None;
    }
    url.set_scheme("https").ok()?;
    url.set_port(origin.port()).ok()?;
    Some(url.to_string())
}

// ── Multistatus parsing ─────────────────────────────────────────────────────

/// One element child of a property value, with its `name` attribute if it has
/// one. Enough for both shapes that matter: `<d:resourcetype><c:calendar/></…>`
/// (the element's identity is the answer) and
/// `<c:supported-calendar-component-set><c:comp name="VEVENT"/></…>` (the
/// attribute is).
#[derive(Debug, Clone, PartialEq)]
pub struct DavChild {
    pub ns: String,
    pub name: String,
    pub attr_name: Option<String>,
}

/// One `DAV:prop` child that came back with a 2xx propstat.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct DavProp {
    pub ns: String,
    pub name: String,
    /// Trimmed text content — empty for a structural property.
    pub text: String,
    /// Every `DAV:href` underneath, in document order.
    pub hrefs: Vec<String>,
    pub children: Vec<DavChild>,
    /// `(ns, name)` of **every** element underneath, at any depth. The one
    /// property that needs it is `current-user-privilege-set`, whose answer is
    /// two levels down (`<d:privilege><d:write-content/></d:privilege>`).
    pub descendants: Vec<(String, String)>,
}

/// One `DAV:response`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct DavResponse {
    pub href: String,
    /// The response-level status, when there is one instead of propstats. This
    /// is how RFC 6578 reports a **deletion**: a bare `<d:response>` with the
    /// href and a `404`.
    pub status: Option<u16>,
    /// Properties from **2xx propstats only**. A `404` propstat means "this
    /// server does not have that property", which is a normal answer to asking
    /// for `getctag` and `sync-token` in one request, not an error.
    pub props: Vec<DavProp>,
}

impl DavResponse {
    pub fn prop(&self, ns: &str, name: &str) -> Option<&DavProp> {
        self.props.iter().find(|p| p.ns == ns && p.name == name)
    }

    pub fn text(&self, ns: &str, name: &str) -> Option<&str> {
        self.prop(ns, name)
            .map(|p| p.text.as_str())
            .filter(|t| !t.is_empty())
    }

    /// The first `DAV:href` inside the named property.
    pub fn href_in(&self, ns: &str, name: &str) -> Option<&str> {
        self.prop(ns, name)?.hrefs.first().map(|h| h.as_str())
    }

    /// A `DAV:resourcetype` naming `CALDAV:calendar` — i.e. an actual calendar
    /// collection rather than the home set, a principal, or a subscription.
    pub fn is_calendar(&self) -> bool {
        self.prop(NS_DAV, "resourcetype").is_some_and(|p| {
            p.children
                .iter()
                .any(|c| c.ns == NS_CALDAV && c.name == "calendar")
        })
    }

    /// The resource is gone (RFC 6578's deletion stub).
    pub fn deleted(&self) -> bool {
        matches!(self.status, Some(404) | Some(410))
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Multistatus {
    pub responses: Vec<DavResponse>,
    /// `sync-collection`'s answer: the token to send next time.
    pub sync_token: Option<String>,
}

/// `HTTP/1.1 207 Multi-Status` → the status code alone.
fn status_code(line: &str) -> Option<u16> {
    line.split_whitespace()
        .find_map(|part| part.parse::<u16>().ok().filter(|c| (100..600).contains(c)))
}

fn is(node: &roxmltree::Node, ns: &str, name: &str) -> bool {
    node.tag_name().name() == name && node.tag_name().namespace().unwrap_or("") == ns
}

/// Collect every `DAV:href` text underneath `node`, at any depth.
fn hrefs_under(node: roxmltree::Node) -> Vec<String> {
    node.descendants()
        .filter(|n| n.is_element() && is(n, NS_DAV, "href"))
        .filter_map(|n| n.text().map(|t| t.trim().to_string()))
        .filter(|t| !t.is_empty())
        .collect()
}

/// Parse a WebDAV `multistatus` document.
///
/// Tolerant on purpose: an unknown property, an unknown namespace, a `404`
/// propstat and a response with no propstat at all are all things real servers
/// send, and none of them is a reason to fail the whole sync. What *is* an
/// error is a body that is not a multistatus at all — that is the shape a login
/// page or an error page takes, and importing zero events silently is exactly
/// the failure `fetch_ics`'s own `BEGIN:VCALENDAR` check exists to prevent.
pub fn parse_multistatus(xml: &str) -> Result<Multistatus, String> {
    let doc = Document::parse_with_options(
        xml,
        roxmltree::ParsingOptions {
            allow_dtd: false,
            ..Default::default()
        },
    )
    .map_err(|e| format!("the server's reply is not valid XML: {e}"))?;

    let root = doc.root_element();
    if !is(&root, NS_DAV, "multistatus") {
        return Err(format!(
            "the server answered with <{}>, not a WebDAV multistatus — is this a CalDAV URL?",
            root.tag_name().name()
        ));
    }

    let mut out = Multistatus::default();
    for child in root.children().filter(|n| n.is_element()) {
        if is(&child, NS_DAV, "sync-token") {
            out.sync_token = child
                .text()
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty());
            continue;
        }
        if !is(&child, NS_DAV, "response") {
            continue;
        }

        let mut resp = DavResponse::default();
        for part in child.children().filter(|n| n.is_element()) {
            if is(&part, NS_DAV, "href") {
                if resp.href.is_empty() {
                    resp.href = part.text().unwrap_or("").trim().to_string();
                }
            } else if is(&part, NS_DAV, "status") {
                resp.status = part.text().and_then(status_code);
            } else if is(&part, NS_DAV, "propstat") {
                let ok = part
                    .children()
                    .filter(|n| n.is_element() && is(n, NS_DAV, "status"))
                    .filter_map(|n| n.text().and_then(status_code))
                    .all(|code| (200..300).contains(&code));
                if !ok {
                    continue;
                }
                for prop in part
                    .children()
                    .filter(|n| n.is_element() && is(n, NS_DAV, "prop"))
                {
                    for value in prop.children().filter(|n| n.is_element()) {
                        resp.props.push(DavProp {
                            ns: value.tag_name().namespace().unwrap_or("").to_string(),
                            name: value.tag_name().name().to_string(),
                            // `text()` is the first text node; a property whose
                            // value is split by a comment or a child element
                            // needs every one of them (`calendar-data` is a
                            // whole iCalendar document and CDATA-splits do
                            // happen), so the descendants are joined.
                            text: value
                                .descendants()
                                .filter(|n| n.is_text())
                                .filter_map(|n| n.text())
                                .collect::<String>()
                                .trim()
                                .to_string(),
                            hrefs: hrefs_under(value),
                            children: value
                                .children()
                                .filter(|n| n.is_element())
                                .map(|c| DavChild {
                                    ns: c.tag_name().namespace().unwrap_or("").to_string(),
                                    name: c.tag_name().name().to_string(),
                                    attr_name: c.attribute("name").map(|a| a.to_string()),
                                })
                                .collect(),
                            descendants: value
                                .descendants()
                                .filter(|n| n.is_element() && *n != value)
                                .map(|c| {
                                    (
                                        c.tag_name().namespace().unwrap_or("").to_string(),
                                        c.tag_name().name().to_string(),
                                    )
                                })
                                .collect(),
                        });
                    }
                }
            }
        }
        if !resp.href.is_empty() || resp.status.is_some() {
            out.responses.push(resp);
        }
    }
    Ok(out)
}

// ── Request bodies ──────────────────────────────────────────────────────────
//
// Six fixed shapes. Everything variable in them is either a URL the server
// itself handed us or a token the server itself minted — both go through
// `xml_escape` anyway, because "the server would never" is not a parser.

/// Escape text for an XML text node. Attributes are never templated here.
fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

const XML_DECL: &str = r#"<?xml version="1.0" encoding="utf-8"?>"#;

pub fn body_current_user_principal() -> String {
    format!(
        r#"{XML_DECL}
<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>"#
    )
}

pub fn body_calendar_home_set() -> String {
    format!(
        r#"{XML_DECL}
<d:propfind xmlns:d="DAV:" xmlns:c="{NS_CALDAV}"><d:prop><c:calendar-home-set/></d:prop></d:propfind>"#
    )
}

/// The collection-listing `PROPFIND`.
///
/// One request for everything a collection row needs. A server that does not
/// have `getctag` or `sync-token` answers those in a `404` propstat and the
/// rest in a `200` one, which the parser already handles — that is why they can
/// share a request instead of costing a round trip each.
pub fn body_collection_props() -> String {
    format!(
        r#"{XML_DECL}
<d:propfind xmlns:d="DAV:" xmlns:c="{NS_CALDAV}" xmlns:cs="{NS_CALSERVER}" xmlns:ical="{NS_APPLE}">
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
    <d:current-user-privilege-set/>
    <c:supported-calendar-component-set/>
    <ical:calendar-color/>
    <cs:getctag/>
    <d:sync-token/>
  </d:prop>
</d:propfind>"#
    )
}

/// The fallback listing body for a server that refuses the full property set.
///
/// SOGo in particular is known to be picky about exactly which properties a
/// `PROPFIND` names, and a whole discovery that fails because one optional
/// property was asked for is a feature that does not work for a reason nobody
/// can see. Two properties, both required by RFC 4918 itself.
pub fn body_collection_props_minimal() -> String {
    format!(
        r#"{XML_DECL}
<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:displayname/></d:prop></d:propfind>"#
    )
}

/// `getctag` + `sync-token` alone — the cheap "is it worth doing the expensive
/// read" check a scheduled sync makes before every full fetch.
pub fn body_change_tokens() -> String {
    format!(
        r#"{XML_DECL}
<d:propfind xmlns:d="DAV:" xmlns:cs="{NS_CALSERVER}"><d:prop><cs:getctag/><d:sync-token/></d:prop></d:propfind>"#
    )
}

/// `calendar-query` for one component type.
///
/// One request per type rather than two `comp-filter` siblings: how a server
/// combines sibling filters is under-specified enough that real clients issue
/// them separately, and a filter silently read as AND returns nothing at all —
/// which looks exactly like an empty calendar.
pub fn body_calendar_query(component: &str) -> String {
    let component = xml_escape(component);
    format!(
        r#"{XML_DECL}
<c:calendar-query xmlns:d="DAV:" xmlns:c="{NS_CALDAV}">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="{component}"/></c:comp-filter></c:filter>
</c:calendar-query>"#
    )
}

pub fn body_multiget(hrefs: &[String]) -> String {
    let hrefs: String = hrefs
        .iter()
        .map(|h| format!("  <d:href>{}</d:href>\n", xml_escape(h)))
        .collect();
    format!(
        r#"{XML_DECL}
<c:calendar-multiget xmlns:d="DAV:" xmlns:c="{NS_CALDAV}">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
{hrefs}</c:calendar-multiget>"#
    )
}

/// RFC 6578's incremental report. An **empty** `sync-token` element is the
/// spec's "I have nothing, send me everything (and a token)".
pub fn body_sync_collection(token: &str) -> String {
    let token = xml_escape(token);
    format!(
        r#"{XML_DECL}
<d:sync-collection xmlns:d="DAV:" xmlns:c="{NS_CALDAV}">
  <d:sync-token>{token}</d:sync-token>
  <d:sync-level>1</d:sync-level>
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
</d:sync-collection>"#
    )
}

// ── HTTP ────────────────────────────────────────────────────────────────────

fn method(name: &str) -> Method {
    Method::from_bytes(name.as_bytes()).expect("static WebDAV method name")
}

/// Build the CalDAV client.
///
/// `install_crypto_provider()` for the reason `browser_engine::reader_client`
/// states: `reqwest` is compiled with `rustls-no-provider`, and rustls 0.23
/// **panics** rather than erroring when no process-default provider is
/// installed — which would happen on a user's machine, inside a command, the
/// first time they synced.
///
/// No cookie store, no `Referer`, and **no redirect policy of its own**: hops
/// are followed by [`dav_request`] so the cap is ours and the method survives
/// (reqwest would turn a `PROPFIND` into a `GET` on a 302, which answers a
/// question nobody asked).
fn client() -> Result<Dav, String> {
    crate::services::mail_engine::install_crypto_provider();
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .redirect(reqwest::redirect::Policy::none())
        // The backstop for E2b: [`dav_reply`] refuses every `http:` hop itself,
        // with a sentence; this makes a hop that slipped past it fail anyway.
        .https_only(true)
        .timeout(CALDAV_TIMEOUT)
        .referer(false)
        .build()
        .map_err(|e| format!("caldav-client: {e}"))?;
    Ok(Dav { client })
}

/// The one way a request leaves this module. A struct rather than a bare
/// `reqwest::Client` so the tests can answer requests in-process
/// ([`tests::fake`]): with `https_only` set, a plain-HTTP mock server could not
/// be reached at all, and no TLS test fixtures exist in this crate.
struct Dav {
    client: reqwest::Client,
}

/// One response, reduced to what [`dav_reply`] reads.
struct Wire {
    status: StatusCode,
    location: Option<String>,
    etag: String,
    body: Vec<u8>,
}

impl Dav {
    fn request(&self, method: Method, url: Url) -> reqwest::RequestBuilder {
        self.client.request(method, url)
    }

    async fn send(&self, req: reqwest::RequestBuilder) -> Result<Wire, String> {
        let req = req.build().map_err(|e| format!("caldav-request: {e}"))?;
        let host = req.url().host_str().unwrap_or("the server").to_string();
        #[cfg(test)]
        if let Some(wire) = tests::fake::answer(&req) {
            return Ok(wire);
        }
        let resp = self.client.execute(req).await.map_err(|e| {
            // `reqwest`'s Display walks the source chain and can print the URL,
            // which never carries the password (it is a header) — but the host
            // is enough context on its own.
            format!("could not reach {host}: {e}")
        })?;
        let status = resp.status();
        let header = |name: reqwest::header::HeaderName| {
            resp.headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(|s| s.trim().to_string())
        };
        let location = header(reqwest::header::LOCATION);
        let etag = header(reqwest::header::ETAG).unwrap_or_default();
        if status.is_redirection() || status == StatusCode::UNAUTHORIZED {
            return Ok(Wire {
                status,
                location,
                etag,
                body: Vec::new(),
            });
        }
        let body = resp
            .bytes()
            .await
            .map_err(|e| format!("the reply could not be read: {e}"))?
            .to_vec();
        Ok(Wire {
            status,
            location,
            etag,
            body,
        })
    }
}

/// The URL a user typed, made into something joinable.
///
/// A bare host (`cal.example.org`) gets `https://` — never `http://`: this
/// carries a password on every request. An explicit `http://` is **refused**
/// (decision E2b, `localhost` included) with [`HTTP_REFUSED`]: a password and a
/// calendar would cross the network in the clear, and a self-hosted server on
/// plain HTTP gets a TLS proxy in front of it instead.
pub fn normalize_base_url(raw: &str) -> Result<Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("no server URL".to_string());
    }
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let url = Url::parse(&with_scheme).map_err(|e| format!("not a usable URL: {e}"))?;
    match url.scheme() {
        "https" => Ok(url),
        "http" => Err(http_refused(url.host_str().unwrap_or("http://"))),
        other => Err(format!(
            "unsupported URL scheme '{other}' — CalDAV is HTTP(S)"
        )),
    }
}

/// One WebDAV request, following redirects ourselves up to [`MAX_REDIRECTS`].
///
/// Returns `(status, body, final_url)`. A non-2xx is **not** an error here: a
/// `404` on `.well-known/caldav` is an ordinary step in discovery, and a `403`
/// on `sync-collection` is the documented way a server says "use a full query
/// instead". Callers decide which ones mean failure.
///
/// The credential rule is [`credentials_may_follow`]'s, applied per hop against
/// the fixed origin in [`Credentials`] — never against the previous hop (a chain
/// of small steps would walk the password anywhere), and never against the URL
/// being requested (a stored href is a string the server chose; gap 26).
async fn dav_request(
    client: &Dav,
    method_name: &str,
    url: &Url,
    cred: &Credentials,
    depth: Option<&str>,
    body: Option<String>,
) -> Result<(StatusCode, String, Url), String> {
    dav_request_with(client, method_name, url, cred, depth, body, &[]).await
}

/// [`dav_request`] plus extra headers — the conditional (`If-Match`,
/// `If-None-Match`) and content-type headers a write needs.
async fn dav_request_with(
    client: &Dav,
    method_name: &str,
    url: &Url,
    cred: &Credentials,
    depth: Option<&str>,
    body: Option<String>,
    headers: &[(&str, String)],
) -> Result<(StatusCode, String, Url), String> {
    let reply = dav_reply(client, method_name, url, cred, depth, body, headers).await?;
    Ok((reply.status, reply.body, reply.url))
}

/// One reply, plus the one header a caller ever needs off it.
///
/// `ETag` is here rather than a whole header map because it is the only one any
/// call site reads — a write's new validator, which is what makes the *next*
/// conditional write possible.
struct DavReply {
    status: StatusCode,
    body: String,
    url: Url,
    etag: String,
}

/// Every hop is judged against `cred.origin` — the account's base URL, never
/// the URL being requested (gap 26). The first hop of a request names a URL
/// that may have come from the server (a principal, home set, collection or
/// resource href); one outside the origin is refused before anything is sent,
/// rather than retried without credentials. A redirect hop outside it goes out
/// without credentials for a read (its `401` then says how to fix it) and is
/// refused for a write, whose body is the user's calendar data. A hop to
/// `http:` is refused outright, wherever it comes from (E2b).
async fn dav_reply(
    client: &Dav,
    method_name: &str,
    url: &Url,
    cred: &Credentials,
    depth: Option<&str>,
    body: Option<String>,
    headers: &[(&str, String)],
) -> Result<DavReply, String> {
    let origin = &cred.origin;
    let writes = matches!(method_name, "PUT" | "DELETE");
    let mut url = url.clone();
    for hop in 0..=MAX_REDIRECTS {
        if url.scheme() != "https" {
            return Err(http_refused(if hop == 0 {
                "the calendar's stored address is not https"
            } else {
                "the server redirected to an insecure address"
            }));
        }
        let authorized = credentials_may_follow(origin, &url);
        if !authorized && (hop == 0 || writes) {
            return Err(off_origin(&url, origin));
        }
        let mut req = client.request(method(method_name), url.clone());
        if authorized {
            req = req.basic_auth(&cred.user, Some(&cred.password));
        }
        if let Some(depth) = depth {
            req = req.header("Depth", depth);
        }
        let mut typed = false;
        for (name, value) in headers {
            typed |= name.eq_ignore_ascii_case("content-type");
            req = req.header(*name, value.clone());
        }
        if let Some(body) = body.clone() {
            // Every *reading* body here is a WebDAV XML document; a write names
            // its own type (`text/calendar`) and must not have this one added on
            // top of it.
            if !typed {
                req = req.header("Content-Type", "application/xml; charset=utf-8");
            }
            req = req.body(body);
        }

        let wire = client.send(req).await?;
        let status = wire.status;

        if status.is_redirection() {
            match wire.location {
                Some(loc) => {
                    let next = url
                        .join(&loc)
                        .map_err(|e| format!("the server redirected somewhere unusable: {e}"))?;
                    if next == url {
                        return Err("the server redirected to the same URL".to_string());
                    }
                    // Judged at the top of the next hop: `http:` is refused
                    // outright, and credentials ride only inside the origin.
                    url = next;
                    continue;
                }
                // A redirect with no Location is a broken server, not a hop.
                None => {
                    return Ok(DavReply {
                        status,
                        body: String::new(),
                        url,
                        etag: String::new(),
                    })
                }
            }
        }

        if status == StatusCode::UNAUTHORIZED {
            // Which of the two 401s this is matters: one is a wrong password,
            // the other is a host we deliberately did not authenticate to, and
            // the fix for the second is not "retype your password".
            if !authorized {
                return Err(format!(
                    concat!("the server redirected to {} and that host asked for the password. ", crate::app_name!(), " \
                     only sends CalDAV credentials to the server the account's URL names (or \
                     another HTTPS host under its domain) — if you trust that address, set the account's \
                     server URL to it directly."),
                    url.host_str().unwrap_or("another host")
                ));
            }
            return Err(
                "the server rejected the username or password (401). Some CalDAV servers want an \
                 app-specific password rather than your normal one — check your provider's \
                 account settings."
                    .to_string(),
            );
        }

        if wire.body.len() > MAX_BODY {
            return Err(format!(
                "the server's reply is too large ({} bytes; limit {MAX_BODY})",
                wire.body.len()
            ));
        }
        let text = String::from_utf8_lossy(&wire.body).into_owned();
        return Ok(DavReply {
            status,
            body: text,
            url,
            etag: wire.etag,
        });
    }
    Err("too many redirects".to_string())
}

/// Whether the Basic-auth header may ride a redirect hop.
///
/// **This is the whole of the redirect defence, and it exists because this
/// module follows hops itself.** `reqwest`'s own redirect policy strips
/// sensitive headers when a hop crosses origins; [`client`] disables that policy
/// (a `PROPFIND` must not become a `GET`), which means the re-attaching of
/// `basic_auth` on each hop is ours to get right. Without this check a server at
/// the URL the user typed — or anyone able to answer for it — can bounce the
/// client to a host of their choosing and be handed the calendar password in a
/// header it can read.
///
/// The rule (decided 2026-10-13, after iCloud-shaped providers broke on the
/// stricter subdomain-only rule):
///
/// - **same origin** (scheme, host, port) — the ordinary case, every hop inside
///   one server's own URL space;
/// - **another host under the credential host's registrable domain, over TLS on
///   both ends** — RFC 6764 discovery (`example.org` → `caldav.example.org`) and
///   providers that hand each account a sibling host (`caldav.example.com` →
///   `p42-caldav.example.com`). The registrable domain (eTLD+1) comes from the
///   public-suffix list (the `psl` crate), so `example.co.uk` never covers the
///   rest of `.co.uk` and `alice.github.io` never covers `bob.github.io`. The
///   other host must answer on the origin's port or on 443: another port on a
///   sibling machine is another service, whoever runs it.
///
/// An IP-address host, a single-label host (`localhost`, `nas`) and a host that
/// *is* a public suffix have no registrable domain and match only exactly. A
/// refusal here is recoverable and says so: the user sets the account's URL to
/// the address the server named, and that address becomes the credential origin.
pub fn credentials_may_follow(from: &Url, to: &Url) -> bool {
    let (Some(from_host), Some(to_host)) = (from.host_str(), to.host_str()) else {
        return false;
    };
    let from_host = from_host.to_ascii_lowercase();
    let to_host = to_host.to_ascii_lowercase();

    if from_host == to_host {
        // The same host on another port, or the same host and port under the
        // other scheme, is another service: same origin only.
        return from.scheme() == to.scheme()
            && from.port_or_known_default() == to.port_or_known_default();
    }
    // Another host is only ever allowed under TLS, on both ends: over plain
    // HTTP the header is readable by anyone on the path, so "which host" stops
    // being the interesting question.
    if from.scheme() != "https" || to.scheme() != "https" {
        return false;
    }
    let to_port = to.port_or_known_default();
    if to_port != from.port_or_known_default() && to_port != Some(443) {
        return false;
    }
    // IP literals (v4 and v6) have no registrable domain: exact match only.
    if !matches!(from.host(), Some(url::Host::Domain(_)))
        || !matches!(to.host(), Some(url::Host::Domain(_)))
    {
        return false;
    }
    match registrable_domain(&from_host) {
        Some(site) => to_host == site || to_host.ends_with(&format!(".{site}")),
        None => false,
    }
}

/// The registrable domain (eTLD+1) of a DNS host, by the public-suffix list —
/// `None` for a single-label host, a host that is itself a public suffix, or a
/// trailing-dot spelling (which then matches only exactly: fail closed).
pub fn registrable_domain(host: &str) -> Option<String> {
    if host.ends_with('.') || !host.contains('.') {
        return None;
    }
    let host = host.to_ascii_lowercase();
    let site = psl::domain_str(&host)?;
    // `psl` falls back to the `*` rule for an unknown TLD, so `nas.lan` is its
    // own site; a name the list knows only as a suffix has none.
    (site.contains('.') && (host == site || host.ends_with(&format!(".{site}"))))
        .then(|| site.to_string())
}

/// A 2xx/207 body, or a described failure. The status text is included because
/// "sync failed" with no number is a bug report nobody can act on.
fn require_ok(status: StatusCode, body: String, what: &str) -> Result<String, String> {
    if status.is_success() {
        return Ok(body);
    }
    Err(format!("{what} failed: HTTP {}", status.as_u16()))
}

/// Resolve an href the server handed back against the URL it came from, and
/// keep it **absolute**.
///
/// The absolute form is the stable key `caldav_href` stores: servers answer
/// with path-only hrefs, and a path alone stops identifying anything the moment
/// a second account on a second host is added.
fn absolute(base: &Url, href: &str) -> Option<String> {
    base.join(href).ok().map(|u| u.to_string())
}

// ── Discovery ───────────────────────────────────────────────────────────────

/// Whether the server said this collection is read-only **to this login**.
///
/// A collection someone else shared with you is legitimately read-only to you,
/// and that is a fact to ask the server for rather than infer from "push
/// shipped". The write privileges are named at RFC 3744 §3: `write` implies the
/// others, and `write-content`/`bind` are what a calendar collection actually
/// grants.
///
/// A server that does not report the property at all comes back **`false`** — an
/// unasserted unknown, not a claim in either direction. That is deliberately the
/// permissive side, and it is safe only because it is never the sole gate: the
/// account's own opt-in (`CalDavAccount::allow_write`) must also be set, and the
/// server's `403` is what actually stops a write it never meant to allow. The
/// alternative — silence read as a refusal — would make the feature unusable
/// against every server that does not implement the property, for no gain the
/// server itself was not already providing.
fn privileges_read_only(resp: &DavResponse) -> bool {
    resp.prop(NS_DAV, "current-user-privilege-set")
        .map(|p| {
            !p.descendants.iter().any(|(ns, name)| {
                ns == NS_DAV && matches!(name.as_str(), "write" | "write-content" | "bind")
            })
        })
        .unwrap_or(false)
}

/// Read one collection response into a [`CalDavCollection`].
fn collection_from(base: &Url, resp: &DavResponse) -> Option<CalDavCollection> {
    let href = absolute(base, &resp.href)?;
    let components: Vec<String> = resp
        .prop(NS_CALDAV, "supported-calendar-component-set")
        .map(|p| {
            p.children
                .iter()
                .filter(|c| c.name == "comp")
                .filter_map(|c| c.attr_name.clone())
                .collect()
        })
        .unwrap_or_default();
    let read_only = privileges_read_only(resp);
    Some(CalDavCollection {
        href,
        display_name: resp
            .text(NS_DAV, "displayname")
            .unwrap_or_default()
            .to_string(),
        color: resp
            .text(NS_APPLE, "calendar-color")
            .unwrap_or_default()
            .to_string(),
        ctag: resp
            .text(NS_CALSERVER, "getctag")
            .unwrap_or_default()
            .to_string(),
        sync_token: resp.text(NS_DAV, "sync-token").map(|s| s.to_string()),
        components,
        read_only,
    })
}

/// `PROPFIND Depth: 1` a collection home and keep the calendar collections.
async fn list_collections(
    client: &Dav,
    url: &Url,
    cred: &Credentials,
) -> Result<Vec<CalDavCollection>, String> {
    let (status, body, final_url) = dav_request(
        client,
        "PROPFIND",
        url,
        cred,
        Some("1"),
        Some(body_collection_props()),
    )
    .await?;

    // A server that refused the full property set gets one more chance with the
    // two properties RFC 4918 requires of everyone.
    let (body, final_url) = if status.is_success() {
        (body, final_url)
    } else {
        let (status, body, final_url) = dav_request(
            client,
            "PROPFIND",
            url,
            cred,
            Some("1"),
            Some(body_collection_props_minimal()),
        )
        .await?;
        (require_ok(status, body, "listing calendars")?, final_url)
    };

    let parsed = parse_multistatus(&body)?;
    let all: Vec<CalDavCollection> = parsed
        .responses
        .iter()
        .filter(|r| r.is_calendar())
        .filter_map(|r| collection_from(&final_url, r))
        .collect();
    in_origin(all, &cred.origin)
}

/// Keep the collections the credentials may reach (gap 26). A server whose
/// every calendar sits elsewhere gets the recoverable sentence instead of a
/// silent "no calendars found".
fn in_origin(all: Vec<CalDavCollection>, origin: &Url) -> Result<Vec<CalDavCollection>, String> {
    let outside = all.iter().find(|c| !href_in_origin(origin, &c.href)).cloned();
    let kept: Vec<CalDavCollection> = all
        .into_iter()
        .filter(|c| href_in_origin(origin, &c.href))
        .collect();
    match (kept.is_empty(), outside) {
        (true, Some(c)) => Err(match Url::parse(&c.href) {
            Ok(u) if u.scheme() != "https" => http_refused("the server listed its calendars at http:// addresses"),
            Ok(u) => off_origin(&u, origin),
            Err(_) => "the server listed its calendars at an unusable address".to_string(),
        }),
        _ => Ok(kept),
    }
}

/// The discovery chain: whatever the user pasted → the calendar collections
/// they can subscribe to.
///
/// Ordered by how likely each step is to be the whole answer, because most
/// manual setups paste a collection URL directly (which is what every desktop
/// client's manual path actually does in practice):
///
/// 1. `PROPFIND Depth: 0` on the URL itself. If it *is* a calendar collection,
///    that is the answer and nothing else runs.
/// 2. If that response carries `calendar-home-set`, list it.
/// 3. If it carries `current-user-principal`, `PROPFIND` that for the home set,
///    then list it.
/// 4. Failing all of the above, `PROPFIND /.well-known/caldav` on the origin
///    (a redirect to the real base path is normal) and try 1–3 again there.
///
/// `cred.origin` is the typed URL itself ([`Credentials::new`]), so the
/// principal and home-set hrefs the server names along the way are held to it
/// (gap 26): one outside it is refused before any request reaches it.
pub async fn discover(base_url: &str, cred: &Credentials) -> Result<Vec<CalDavCollection>, String> {
    let url = normalize_base_url(base_url)?;
    let client = client()?;

    if let Some(found) = discover_from(&client, &url, cred).await? {
        return Ok(found);
    }

    // `.well-known` is only meaningful on the origin, and only worth trying
    // when it is not where we already looked.
    let well_known = url
        .join("/.well-known/caldav")
        .map_err(|e| format!("not a usable URL: {e}"))?;
    if well_known != url {
        if let Some(found) = discover_from(&client, &well_known, cred).await? {
            return Ok(found);
        }
    }

    Err(
        "no calendars found there — check the URL, or paste the address of the calendar \
         collection itself (your provider's CalDAV documentation usually gives one)"
            .to_string(),
    )
}

/// Steps 1–3 of [`discover`] against one URL. `Ok(None)` means "nothing here",
/// which is a reason to try the next URL rather than to fail.
async fn discover_from(
    client: &Dav,
    url: &Url,
    cred: &Credentials,
) -> Result<Option<Vec<CalDavCollection>>, String> {
    let (status, body, final_url) =
        dav_request(client, "PROPFIND", url, cred, Some("0"), Some(body_probe())).await?;
    if !status.is_success() {
        return Ok(None);
    }
    let parsed = parse_multistatus(&body)?;
    let Some(resp) = parsed.responses.first() else {
        return Ok(None);
    };

    // 1. The URL is itself a calendar. Its Depth-0 response already carries
    //    everything the row needs.
    if resp.is_calendar() {
        if let Some(one) = collection_from(&final_url, resp) {
            return in_origin(vec![one], &cred.origin).map(Some);
        }
    }

    // 2. A calendar home set, named right here.
    if let Some(home) = resp.href_in(NS_CALDAV, "calendar-home-set") {
        if let Some(home) = absolute(&final_url, home).and_then(|h| Url::parse(&h).ok()) {
            let found = list_collections(client, &home, cred).await?;
            if !found.is_empty() {
                return Ok(Some(found));
            }
        }
    }

    // 3. A principal, whose home set is one more round trip away.
    if let Some(principal) = resp.href_in(NS_DAV, "current-user-principal") {
        if let Some(principal) = absolute(&final_url, principal).and_then(|h| Url::parse(&h).ok()) {
            let (status, body, principal_url) = dav_request(
                client,
                "PROPFIND",
                &principal,
                cred,
                Some("0"),
                Some(body_calendar_home_set()),
            )
            .await?;
            if status.is_success() {
                let parsed = parse_multistatus(&body)?;
                if let Some(home) = parsed
                    .responses
                    .first()
                    .and_then(|r| r.href_in(NS_CALDAV, "calendar-home-set"))
                    .and_then(|h| absolute(&principal_url, h))
                    .and_then(|h| Url::parse(&h).ok())
                {
                    let found = list_collections(client, &home, cred).await?;
                    if !found.is_empty() {
                        return Ok(Some(found));
                    }
                }
            }
        }
    }

    Ok(None)
}

/// The Depth-0 probe body: "are you a calendar, and if not, where do I go next".
/// One request instead of three, because all three answers are properties.
fn body_probe() -> String {
    format!(
        r#"{XML_DECL}
<d:propfind xmlns:d="DAV:" xmlns:c="{NS_CALDAV}" xmlns:cs="{NS_CALSERVER}" xmlns:ical="{NS_APPLE}">
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
    <d:current-user-principal/>
    <c:calendar-home-set/>
    <c:supported-calendar-component-set/>
    <ical:calendar-color/>
    <cs:getctag/>
    <d:sync-token/>
  </d:prop>
</d:propfind>"#
    )
}

// ── Change detection and fetching ───────────────────────────────────────────

/// The collection's current change tokens: `(ctag, sync_token)`.
///
/// The cheap half of a scheduled sync. An unchanged ctag means the expensive
/// `calendar-query` can be skipped entirely — which is the difference between a
/// background timer that costs one small request every few minutes and one that
/// re-downloads a whole calendar.
pub async fn change_tokens(
    href: &str,
    cred: &Credentials,
) -> Result<(String, Option<String>), String> {
    let url = Url::parse(href).map_err(|e| format!("not a usable calendar URL: {e}"))?;
    let client = client()?;
    let (status, body, _) = dav_request(
        &client,
        "PROPFIND",
        &url,
        cred,
        Some("0"),
        Some(body_change_tokens()),
    )
    .await?;
    let body = require_ok(status, body, "checking the calendar for changes")?;
    let parsed = parse_multistatus(&body)?;
    let resp = parsed
        .responses
        .first()
        .ok_or_else(|| "the server answered with an empty multistatus".to_string())?;
    Ok((
        resp.text(NS_CALSERVER, "getctag")
            .unwrap_or_default()
            .to_string(),
        resp.text(NS_DAV, "sync-token").map(|s| s.to_string()),
    ))
}

/// Turn a multistatus into resources and deletions.
///
/// A resource href outside the credential `origin` is never stored: it would
/// become a row's `caldav_href`, and every later push or delete of that row
/// would aim the password at it (gap 26). It fails the whole read, with the
/// recoverable sentence, rather than being dropped: a full listing is
/// authoritative about what exists, so a silently dropped resource would delete
/// its local copy and report the sync as a success (a server behind a proxy that
/// names its resources `http://…` would empty the calendar). A deletion stub
/// outside the origin is ignored — no stored row can carry that address.
fn changes_from(
    base: &Url,
    origin: &Url,
    parsed: &Multistatus,
    incremental: bool,
) -> Result<CalDavChanges, String> {
    let mut resources = Vec::new();
    let mut removed = Vec::new();
    for resp in &parsed.responses {
        let Some(href) = absolute(base, &resp.href) else {
            continue;
        };
        let inside = href_in_origin(origin, &href);
        if resp.deleted() {
            if inside {
                removed.push(href);
            }
            continue;
        }
        // The collection itself comes back in its own report; it is not a
        // resource and has no calendar data.
        let etag = resp.text(NS_DAV, "getetag").unwrap_or_default().to_string();
        let data = resp
            .text(NS_CALDAV, "calendar-data")
            .unwrap_or_default()
            .to_string();
        if etag.is_empty() && data.is_empty() {
            continue;
        }
        if !inside {
            return Err(match Url::parse(&href) {
                Ok(u) if u.scheme() != "https" => {
                    http_refused("the server listed this calendar's entries at http:// addresses")
                }
                Ok(u) => off_origin(&u, origin),
                Err(_) => "the server listed an entry at an unusable address".to_string(),
            });
        }
        resources.push(CalDavResource { href, etag, data });
    }
    Ok(CalDavChanges {
        resources,
        removed,
        sync_token: parsed.sync_token.clone(),
        ctag: String::new(),
        incremental,
        unchanged: false,
    })
}

/// Fetch resources whose data did not ride along with their etag.
///
/// `sync-collection` is allowed to answer with etags only, and several servers
/// do. Without this pass those resources would look like "changed, but empty",
/// and an empty `calendar-data` parses to zero events — i.e. a change would
/// quietly blank a row instead of updating it.
async fn fill_missing_data(
    client: &Dav,
    collection: &Url,
    cred: &Credentials,
    changes: &mut CalDavChanges,
) -> Result<(), String> {
    let missing: Vec<String> = changes
        .resources
        .iter()
        .filter(|r| r.data.trim().is_empty())
        .map(|r| r.href.clone())
        .collect();
    if missing.is_empty() {
        return Ok(());
    }
    for chunk in missing.chunks(MULTIGET_CHUNK) {
        let (status, body, _) = dav_request(
            client,
            "REPORT",
            collection,
            cred,
            Some("1"),
            Some(body_multiget(chunk)),
        )
        .await?;
        let body = require_ok(status, body, "fetching changed events")?;
        let parsed = parse_multistatus(&body)?;
        let fetched = changes_from(collection, &cred.origin, &parsed, true)?;
        for got in fetched.resources {
            if let Some(slot) = changes.resources.iter_mut().find(|r| r.href == got.href) {
                if !got.data.trim().is_empty() {
                    slot.data = got.data;
                    if !got.etag.is_empty() {
                        slot.etag = got.etag;
                    }
                }
            }
        }
        // A resource the multiget reports as gone really is gone.
        for href in fetched.removed {
            changes.resources.retain(|r| r.href != href);
            if !changes.removed.contains(&href) {
                changes.removed.push(href);
            }
        }
    }
    Ok(())
}

/// Everything in the collection, via `calendar-query` — one report per
/// component type the collection holds.
///
/// `components` empty means "the server did not say", in which case both are
/// asked for: a collection that holds no VTODOs answers the VTODO query with an
/// empty multistatus, which costs one round trip and never lies.
pub async fn fetch_all(
    href: &str,
    cred: &Credentials,
    components: &[String],
) -> Result<CalDavChanges, String> {
    let url = Url::parse(href).map_err(|e| format!("not a usable calendar URL: {e}"))?;
    let client = client()?;

    let wanted: Vec<&str> = if components.is_empty() {
        vec!["VEVENT", "VTODO"]
    } else {
        components
            .iter()
            .map(|c| c.as_str())
            .filter(|c| matches!(*c, "VEVENT" | "VTODO"))
            .collect()
    };

    let mut out = CalDavChanges {
        incremental: false,
        ..Default::default()
    };
    for component in wanted {
        let (status, body, final_url) = dav_request(
            &client,
            "REPORT",
            &url,
            cred,
            Some("1"),
            Some(body_calendar_query(component)),
        )
        .await?;
        let body = require_ok(status, body, "reading the calendar")?;
        let parsed = parse_multistatus(&body)?;
        let mut got = changes_from(&final_url, &cred.origin, &parsed, false)?;
        out.resources.append(&mut got.resources);
    }

    fill_missing_data(&client, &url, cred, &mut out).await?;
    // The token to hand back next time comes from the collection itself: a
    // `calendar-query` does not mint one.
    let (ctag, sync_token) = change_tokens(href, cred).await.unwrap_or_default();
    out.ctag = ctag;
    out.sync_token = sync_token;
    Ok(out)
}

/// RFC 6578's incremental report: only what changed since `token`, plus
/// deletions as `404` stubs.
///
/// A server that does not implement it, or one that has expired the token,
/// answers `403`/`409` with a `valid-sync-token` precondition — both are
/// reported as `Err`, and the caller's answer to that is a full [`fetch_all`],
/// which is the fallback every pre-RFC-6578 server has always been on.
pub async fn fetch_changes(
    href: &str,
    cred: &Credentials,
    token: &str,
) -> Result<CalDavChanges, String> {
    let url = Url::parse(href).map_err(|e| format!("not a usable calendar URL: {e}"))?;
    let client = client()?;
    let (status, body, final_url) = dav_request(
        &client,
        "REPORT",
        &url,
        cred,
        Some("1"),
        Some(body_sync_collection(token)),
    )
    .await?;
    let body = require_ok(status, body, "reading the calendar's changes")?;
    let parsed = parse_multistatus(&body)?;
    let mut out = changes_from(&final_url, &cred.origin, &parsed, true)?;
    if out.sync_token.is_none() {
        return Err("the server's incremental sync reply carried no token".to_string());
    }
    fill_missing_data(&client, &url, cred, &mut out).await?;
    let (ctag, _) = change_tokens(href, cred).await.unwrap_or_default();
    out.ctag = ctag;
    Ok(out)
}

// ── Writing (Phase 3) ───────────────────────────────────────────────────────
//
// Four rules carry this half, and each of them is one line of code plus a reason
// nobody can see from the line:
//
// 1. **Every write is conditional.** A create sends `If-None-Match: *`, an update
//    sends `If-Match: <etag>`, a delete sends `If-Match: <etag>`. There is no
//    unconditional path — not even a fallback for a server that returned no
//    validator — because the unconditional write is precisely the one that
//    destroys an edit made from a phone between the read and the write, and does
//    it *quietly*.
// 2. **A `412` is a value, not an error.** See [`CalDavWrite`].
// 3. **The client names the resource.** RFC 4791 §5.3.2 leaves the URL to the
//    client, so a create mints `<collection>/<uid>.ics`. The uid comes from
//    Tabtivity's own row id, but it is sanitized anyway ([`resource_name`]) — a UID
//    that arrived from an *imported* ICS file is text somebody else wrote, and it
//    would otherwise be a path-traversal primitive aimed at the server.
// 4. **The body is `text/calendar`.** Sent verbatim, exactly as the frontend's
//    `lib/calendar/ics.ts` serialized it, so the one iCalendar writer in this codebase is
//    the one whose output reaches the server.

/// What a `PUT` is conditional on.
pub enum WriteCondition {
    /// A create: `If-None-Match: *` — succeed only if nothing is there.
    Create,
    /// An update: `If-Match: <etag>` — succeed only if the resource is still the
    /// one that was read.
    Update(String),
}

/// The last path segment for a new resource, from a UID.
///
/// Everything outside `[A-Za-z0-9._-]` becomes `-`, the result is capped, and an
/// empty one is refused rather than defaulted — a resource name is a URL path
/// segment, and a UID is text that may have come from a file somebody else wrote.
pub fn resource_name(uid: &str) -> Result<String, String> {
    let cleaned: String = uid
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .take(120)
        .collect();
    // `.` and `..` survive the character filter and are exactly the two names
    // that must not reach a URL join. Trimming both characters in one pass (not
    // dots then dashes) is what makes `../../x` come back as `x` rather than as
    // a name that still opens with a dot run.
    let trimmed = cleaned.trim_matches(|c| c == '.' || c == '-');
    if trimmed.is_empty() {
        return Err("this event has no usable identifier to store it under".to_string());
    }
    Ok(format!("{trimmed}.ics"))
}

/// The absolute URL a new resource gets inside `collection`.
pub fn resource_url(collection: &str, uid: &str) -> Result<String, String> {
    let base = Url::parse(collection).map_err(|e| format!("not a usable calendar URL: {e}"))?;
    // A collection href must end in `/` for `join` to place the child *inside*
    // it rather than beside it. Servers are inconsistent about the trailing
    // slash, so it is added here rather than assumed.
    let base = if base.path().ends_with('/') {
        base
    } else {
        Url::parse(&format!("{base}/")).map_err(|e| format!("not a usable calendar URL: {e}"))?
    };
    base.join(&resource_name(uid)?)
        .map(|u| u.to_string())
        .map_err(|e| format!("not a usable calendar URL: {e}"))
}

/// One resource's ETag as the server holds it *now*.
///
/// Two callers, one shape. After a write whose reply carried no `ETag` header
/// (allowed, and several servers do it) this is what keeps the row conditional
/// instead of stranding it until a full sync. And it is what makes resolving a
/// conflict an *informed* overwrite rather than an unconditional one: "keep
/// mine" re-reads the validator and writes against that, so the write still
/// fails if the resource moved again between the question and the answer.
pub async fn current_etag(href: &str, cred: &Credentials) -> Result<String, String> {
    let url = Url::parse(href).map_err(|e| format!("not a usable calendar URL: {e}"))?;
    let client = client()?;
    Ok(resource_etag(&client, &url, cred).await)
}

async fn resource_etag(client: &Dav, url: &Url, cred: &Credentials) -> String {
    let body = format!(
        r#"{XML_DECL}
<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>"#
    );
    let Ok((status, body, _)) =
        dav_request(client, "PROPFIND", url, cred, Some("0"), Some(body)).await
    else {
        return String::new();
    };
    if !status.is_success() {
        return String::new();
    }
    parse_multistatus(&body)
        .ok()
        .and_then(|m| {
            m.responses
                .first()
                .and_then(|r| r.text(NS_DAV, "getetag"))
                .map(|s| s.to_string())
        })
        .unwrap_or_default()
}

/// `PUT` one resource's iCalendar text.
pub async fn put_resource(
    href: &str,
    cred: &Credentials,
    ics: &str,
    condition: WriteCondition,
) -> Result<CalDavWrite, String> {
    let url = Url::parse(href).map_err(|e| format!("not a usable calendar URL: {e}"))?;
    let client = client()?;

    let condition_header = match &condition {
        WriteCondition::Create => ("If-None-Match", "*".to_string()),
        WriteCondition::Update(etag) => {
            let etag = etag.trim();
            if etag.is_empty() {
                // The one place this can happen is a row whose server never
                // returned a validator and whose collection has not been synced
                // since. Refusing is the point: the alternative is an
                // unconditional PUT, i.e. rule 1 with an exception.
                return Err(
                    "this event has no server version to compare against — sync the calendar \
                     once, then try again"
                        .to_string(),
                );
            }
            ("If-Match", etag.to_string())
        }
    };

    let reply = dav_reply(
        &client,
        "PUT",
        &url,
        cred,
        None,
        Some(ics.to_string()),
        &[
            ("Content-Type", "text/calendar; charset=utf-8".to_string()),
            (condition_header.0, condition_header.1),
        ],
    )
    .await?;

    if reply.status == StatusCode::PRECONDITION_FAILED {
        return Ok(CalDavWrite {
            href: reply.url.to_string(),
            conflict: true,
            ..Default::default()
        });
    }
    if !reply.status.is_success() {
        return Err(write_failure(reply.status, "saving to the server"));
    }

    let etag = if reply.etag.is_empty() {
        resource_etag(&client, &reply.url, cred).await
    } else {
        reply.etag
    };
    Ok(CalDavWrite {
        href: reply.url.to_string(),
        etag,
        conflict: false,
        gone: false,
        dirty: false,
    })
}

/// `DELETE` one resource, conditional on the ETag that was read.
///
/// A `404`/`410` is **success**: the resource is gone, which is what was asked
/// for. Reporting that as a failure would leave a local row nobody can delete
/// without the server first inventing it again.
pub async fn delete_resource(
    href: &str,
    cred: &Credentials,
    etag: &str,
) -> Result<CalDavWrite, String> {
    let url = Url::parse(href).map_err(|e| format!("not a usable calendar URL: {e}"))?;
    let client = client()?;
    let etag = etag.trim();
    if etag.is_empty() {
        return Err(
            "this event has no server version to compare against — sync the calendar once, then \
             try again"
                .to_string(),
        );
    }

    let reply = dav_reply(
        &client,
        "DELETE",
        &url,
        cred,
        None,
        None,
        &[("If-Match", etag.to_string())],
    )
    .await?;

    if reply.status == StatusCode::PRECONDITION_FAILED {
        return Ok(CalDavWrite {
            href: reply.url.to_string(),
            conflict: true,
            ..Default::default()
        });
    }
    if reply.status == StatusCode::NOT_FOUND || reply.status == StatusCode::GONE {
        return Ok(CalDavWrite {
            href: reply.url.to_string(),
            gone: true,
            ..Default::default()
        });
    }
    if !reply.status.is_success() {
        return Err(write_failure(reply.status, "deleting on the server"));
    }
    Ok(CalDavWrite {
        href: reply.url.to_string(),
        gone: true,
        ..Default::default()
    })
}

/// A failed write, said in words the user can act on.
///
/// `403` is the one worth naming: it is what a collection that is read-only *to
/// this login* answers, and "HTTP 403" alone sends people to retype a password
/// that was never the problem.
fn write_failure(status: StatusCode, what: &str) -> String {
    match status {
        StatusCode::FORBIDDEN => format!(
            "{what} failed: the server refused (403). This calendar is most likely read-only for \
             your login — a calendar someone else shared with you usually is."
        ),
        StatusCode::CONFLICT => format!(
            "{what} failed: the server reported a conflict (409). The calendar collection may \
             have been moved or deleted on the server."
        ),
        other => format!("{what} failed: HTTP {}", other.as_u16()),
    }
}

/// Re-read one collection's `current-user-privilege-set`.
///
/// Separate from discovery because access **changes**: a colleague grants write
/// on a shared calendar months after it was subscribed to, and the alternative to
/// asking again is deleting the subscription and making it afresh.
pub async fn collection_read_only(href: &str, cred: &Credentials) -> Result<bool, String> {
    let url = Url::parse(href).map_err(|e| format!("not a usable calendar URL: {e}"))?;
    let client = client()?;
    let body = format!(
        r#"{XML_DECL}
<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-privilege-set/></d:prop></d:propfind>"#
    );
    let (status, body, final_url) =
        dav_request(&client, "PROPFIND", &url, cred, Some("0"), Some(body)).await?;
    let body = require_ok(status, body, "checking this calendar's permissions")?;
    let parsed = parse_multistatus(&body)?;
    let resp = parsed
        .responses
        .first()
        .ok_or_else(|| "the server answered with an empty multistatus".to_string())?;
    let _ = final_url;
    Ok(privileges_read_only(resp))
}

// ── Tests ───────────────────────────────────────────────────────────────────
//
// Fixtures, no live server — the posture `mail_authres`/`mail_engine`'s parsers
// already take, and the only honest one for a protocol whose real-world
// counterparties are an institutional groupware server and a self-hosted
// Radicale. Bodies below are RFC 4791/6578's own worked examples, trimmed, plus
// the shapes real servers add (Apple's `getctag`, SOGo's namespace-prefix
// choices, a Radicale-style path-only href).

#[cfg(test)]
mod tests {
    use super::*;

    const HOME_LISTING: &str = r#"<?xml version="1.0" encoding="utf-8" ?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"
               xmlns:CS="http://calendarserver.org/ns/"
               xmlns:IC="http://apple.com/ns/ical/">
  <D:response>
    <D:href>/calendars/user/</D:href>
    <D:propstat>
      <D:prop><D:resourcetype><D:collection/></D:resourcetype><D:displayname>Home</D:displayname></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/calendars/user/personal/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
        <D:displayname>Personal</D:displayname>
        <IC:calendar-color>#4aa3dfff</IC:calendar-color>
        <CS:getctag>ctag-42</CS:getctag>
        <C:supported-calendar-component-set>
          <C:comp name="VEVENT"/><C:comp name="VTODO"/>
        </C:supported-calendar-component-set>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
    <D:propstat>
      <D:prop><D:sync-token/></D:prop>
      <D:status>HTTP/1.1 404 Not Found</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;

    #[test]
    fn parses_a_home_listing_and_keeps_only_calendars() {
        let base = Url::parse("https://dav.example.org/calendars/user/").unwrap();
        let parsed = parse_multistatus(HOME_LISTING).unwrap();
        assert_eq!(parsed.responses.len(), 2);

        let calendars: Vec<CalDavCollection> = parsed
            .responses
            .iter()
            .filter(|r| r.is_calendar())
            .filter_map(|r| collection_from(&base, r))
            .collect();
        assert_eq!(
            calendars.len(),
            1,
            "the home collection itself is not a calendar"
        );
        let cal = &calendars[0];
        assert_eq!(cal.href, "https://dav.example.org/calendars/user/personal/");
        assert_eq!(cal.display_name, "Personal");
        assert_eq!(cal.color, "#4aa3dfff");
        assert_eq!(cal.ctag, "ctag-42");
        assert_eq!(cal.components, vec!["VEVENT", "VTODO"]);
    }

    #[test]
    fn a_404_propstat_is_an_absent_property_not_a_failure() {
        let parsed = parse_multistatus(HOME_LISTING).unwrap();
        let cal = parsed.responses.iter().find(|r| r.is_calendar()).unwrap();
        assert!(
            cal.text(NS_DAV, "sync-token").is_none(),
            "a property answered 404 must not be read as present-and-empty"
        );
        assert_eq!(cal.text(NS_CALSERVER, "getctag"), Some("ctag-42"));
    }

    #[test]
    fn privileges_decide_read_only_and_silence_asserts_nothing() {
        let shared = r#"<?xml version="1.0" encoding="utf-8" ?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/calendars/other/shared/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
        <D:current-user-privilege-set>
          <D:privilege><D:read/></D:privilege>
        </D:current-user-privilege-set>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;
        let base = Url::parse("https://dav.example.org/").unwrap();
        let parsed = parse_multistatus(shared).unwrap();
        let cal = collection_from(&base, &parsed.responses[0]).unwrap();
        assert!(
            cal.read_only,
            "read-only privileges are a fact the server stated"
        );

        // A server that reports no privileges at all asserts nothing — the
        // field stays false rather than claiming writability either way.
        let silent = parse_multistatus(HOME_LISTING).unwrap();
        let cal = silent
            .responses
            .iter()
            .find(|r| r.is_calendar())
            .and_then(|r| collection_from(&base, r))
            .unwrap();
        assert!(!cal.read_only);
    }

    #[test]
    fn a_writable_collection_is_not_flagged_read_only() {
        let xml = r#"<?xml version="1.0" encoding="utf-8" ?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/calendars/me/personal/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
        <D:current-user-privilege-set>
          <D:privilege><D:read/></D:privilege>
          <D:privilege><D:write-content/></D:privilege>
          <D:privilege><D:bind/></D:privilege>
        </D:current-user-privilege-set>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;
        let base = Url::parse("https://dav.example.org/").unwrap();
        let parsed = parse_multistatus(xml).unwrap();
        assert!(
            !collection_from(&base, &parsed.responses[0])
                .unwrap()
                .read_only
        );
    }

    #[test]
    fn parses_a_calendar_query_report_with_inline_data() {
        let xml = r#"<?xml version="1.0" encoding="utf-8" ?>
<multistatus xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <response>
    <href>/calendars/user/personal/abc.ics</href>
    <propstat>
      <prop>
        <getetag>"etag-1"</getetag>
        <c:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:abc
DTSTART:20260708T090000Z
SUMMARY:standup
END:VEVENT
END:VCALENDAR
</c:calendar-data>
      </prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
  </response>
</multistatus>"#;
        let base = Url::parse("https://dav.example.org/calendars/user/personal/").unwrap();
        let parsed = parse_multistatus(xml).unwrap();
        let changes = changes_from(&base, &base, &parsed, false).unwrap();
        assert_eq!(changes.resources.len(), 1);
        let res = &changes.resources[0];
        assert_eq!(
            res.href,
            "https://dav.example.org/calendars/user/personal/abc.ics"
        );
        assert_eq!(res.etag, "\"etag-1\"");
        assert!(res.data.starts_with("BEGIN:VCALENDAR"));
        assert!(res.data.contains("SUMMARY:standup"));
        assert!(changes.removed.is_empty());
    }

    #[test]
    fn sync_collection_reports_deletions_as_404_stubs() {
        let xml = r#"<?xml version="1.0" encoding="utf-8" ?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/cal/kept.ics</D:href>
    <D:propstat>
      <D:prop><D:getetag>"e2"</D:getetag><C:calendar-data>BEGIN:VCALENDAR
END:VCALENDAR</C:calendar-data></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/cal/gone.ics</D:href>
    <D:status>HTTP/1.1 404 Not Found</D:status>
  </D:response>
  <D:sync-token>http://example.com/sync/2</D:sync-token>
</D:multistatus>"#;
        let base = Url::parse("https://dav.example.org/cal/").unwrap();
        let parsed = parse_multistatus(xml).unwrap();
        assert_eq!(
            parsed.sync_token.as_deref(),
            Some("http://example.com/sync/2")
        );
        let changes = changes_from(&base, &base, &parsed, true).unwrap();
        assert_eq!(changes.resources.len(), 1);
        assert_eq!(
            changes.resources[0].href,
            "https://dav.example.org/cal/kept.ics"
        );
        assert_eq!(
            changes.removed,
            vec!["https://dav.example.org/cal/gone.ics"]
        );
        assert!(changes.incremental);
    }

    #[test]
    fn an_etag_without_data_is_kept_for_the_multiget_pass() {
        let xml = r#"<?xml version="1.0" encoding="utf-8" ?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/cal/one.ics</D:href>
    <D:propstat><D:prop><D:getetag>"e"</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
</D:multistatus>"#;
        let base = Url::parse("https://dav.example.org/cal/").unwrap();
        let changes = changes_from(&base, &base, &parse_multistatus(xml).unwrap(), true).unwrap();
        assert_eq!(changes.resources.len(), 1);
        assert!(
            changes.resources[0].data.is_empty(),
            "an empty body must survive to the multiget pass, not be dropped"
        );
    }

    #[test]
    fn the_principal_and_home_set_chain_reads_hrefs() {
        let xml = r#"<?xml version="1.0" encoding="utf-8" ?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/</d:href>
    <d:propstat>
      <d:prop><d:current-user-principal><d:href>/principals/users/me/</d:href></d:current-user-principal></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>"#;
        let parsed = parse_multistatus(xml).unwrap();
        let resp = parsed.responses.first().unwrap();
        assert_eq!(
            resp.href_in(NS_DAV, "current-user-principal"),
            Some("/principals/users/me/")
        );
        let base = Url::parse("https://dav.example.org/").unwrap();
        assert_eq!(
            absolute(
                &base,
                resp.href_in(NS_DAV, "current-user-principal").unwrap()
            )
            .as_deref(),
            Some("https://dav.example.org/principals/users/me/")
        );
    }

    #[test]
    fn a_login_page_is_an_error_not_an_empty_calendar() {
        // The failure this check exists for: an expired session or an SSO
        // redirect answers 200 with HTML, and "parsed zero events" is
        // indistinguishable from a calendar that is genuinely empty.
        let err = parse_multistatus("<html><body>Please log in</body></html>").unwrap_err();
        assert!(err.contains("multistatus"), "{err}");
    }

    #[test]
    fn a_non_xml_body_fails_loudly() {
        assert!(parse_multistatus("not xml at all").is_err());
    }

    #[test]
    fn request_bodies_are_well_formed_xml() {
        for body in [
            body_current_user_principal(),
            body_calendar_home_set(),
            body_collection_props(),
            body_collection_props_minimal(),
            body_change_tokens(),
            body_probe(),
            body_calendar_query("VEVENT"),
            body_multiget(&["/cal/a.ics".to_string(), "/cal/b&c.ics".to_string()]),
            body_sync_collection("http://example.com/sync/1"),
        ] {
            Document::parse(&body).unwrap_or_else(|e| panic!("body is not valid XML: {e}\n{body}"));
        }
    }

    #[test]
    fn a_token_with_xml_syntax_in_it_is_escaped() {
        let body = body_sync_collection("tok&<en>");
        assert!(body.contains("tok&amp;&lt;en&gt;"));
        Document::parse(&body).unwrap();
    }

    #[test]
    fn a_bare_host_gets_https_never_http() {
        assert_eq!(
            normalize_base_url("cal.example.org/dav").unwrap().as_str(),
            "https://cal.example.org/dav"
        );
        // An explicit http:// is refused with the fixed code (E2b), the
        // self-hosted-on-localhost case included.
        for raw in ["http://localhost:5232/", "http://dav.example.org/", "HTTP://dav.example.org/"] {
            let err = normalize_base_url(raw).unwrap_err();
            assert!(err.starts_with(HTTP_REFUSED), "{raw}: {err}");
        }
        assert!(normalize_base_url("ftp://example.org").is_err());
        assert!(normalize_base_url("   ").is_err());
    }

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn credentials_ride_a_hop_inside_the_same_origin() {
        let from = u("https://dav.example.org/dav/");
        assert!(credentials_may_follow(
            &from,
            &u("https://dav.example.org/dav/me/")
        ));
        assert!(credentials_may_follow(
            &from,
            &u("https://dav.example.org/other")
        ));
        // A different port is a different service, whoever runs it.
        assert!(!credentials_may_follow(
            &from,
            &u("https://dav.example.org:8443/dav/")
        ));
    }

    #[test]
    fn credentials_ride_the_well_known_hop_down_into_a_subdomain() {
        // RFC 6764's own shape: the user types the bare domain, and
        // `/.well-known/caldav` redirects to the DAV host.
        let from = u("https://example.org/.well-known/caldav");
        assert!(credentials_may_follow(
            &from,
            &u("https://caldav.example.org/dav/")
        ));
        assert!(credentials_may_follow(
            &from,
            &u("https://a.b.example.org/dav/")
        ));
    }

    #[test]
    fn credentials_never_ride_a_hop_to_another_host() {
        let from = u("https://dav.example.org/dav/");
        // The attack this whole check exists for.
        assert!(!credentials_may_follow(
            &from,
            &u("https://evil.example/dav/")
        ));
        // Suffix matching must not be substring matching.
        assert!(!credentials_may_follow(
            &from,
            &u("https://notdav.example.org.evil.test/")
        ));
        assert!(!credentials_may_follow(
            &from,
            &u("https://evilexample.org/")
        ));
    }

    #[test]
    fn credentials_ride_to_a_sibling_host_under_the_same_registrable_domain() {
        // The iCloud shape (decision 2026-10-13): the account names one host,
        // the principal and calendars live on a per-user sibling.
        let from = u("https://caldav.example.com/");
        assert!(credentials_may_follow(
            &from,
            &u("https://p42-caldav.example.com/123/calendars/")
        ));
        assert!(credentials_may_follow(&from, &u("https://example.com/dav/")));
        assert!(credentials_may_follow(&from, &u("https://a.b.example.com/")));
        // A different registrable domain is refused, however alike it looks.
        assert!(!credentials_may_follow(&from, &u("https://p42-caldav.example.net/")));
        assert!(!credentials_may_follow(&from, &u("https://caldav.example.com.evil.test/")));
        // Over http on either end: never another host.
        assert!(!credentials_may_follow(&from, &u("http://p42-caldav.example.com/")));
        // Another port on a sibling machine is another service; 443 is the
        // https service of that host.
        assert!(!credentials_may_follow(&from, &u("https://p42-caldav.example.com:8443/")));
        let odd = u("https://caldav.example.com:8443/");
        assert!(credentials_may_follow(&odd, &u("https://p42-caldav.example.com:8443/")));
        assert!(credentials_may_follow(&odd, &u("https://p42-caldav.example.com/")));
        assert!(!credentials_may_follow(&odd, &u("https://p42-caldav.example.com:9443/")));
        // The same host keeps the same-origin rule: its other ports are not ours.
        assert!(!credentials_may_follow(&odd, &u("https://caldav.example.com/")));
    }

    #[test]
    fn the_registrable_domain_comes_from_the_public_suffix_list() {
        // `example.co.uk` never covers the rest of `.co.uk`.
        let uk = u("https://dav.example.co.uk/");
        assert!(credentials_may_follow(&uk, &u("https://p1.example.co.uk/")));
        assert!(!credentials_may_follow(&uk, &u("https://evil.co.uk/")));
        assert!(!credentials_may_follow(&uk, &u("https://co.uk/")));
        assert_eq!(registrable_domain("dav.example.co.uk").as_deref(), Some("example.co.uk"));
        // Private-section suffixes too: one user's pages are not another's.
        let gh = u("https://alice.github.io/dav/");
        assert!(!credentials_may_follow(&gh, &u("https://bob.github.io/")));
        assert!(!credentials_may_follow(&gh, &u("https://github.io/")));
        // A host that *is* a public suffix has no site: exact match only.
        assert_eq!(registrable_domain("co.uk"), None);
        let bare = u("https://co.uk/");
        assert!(!credentials_may_follow(&bare, &u("https://example.co.uk/")));
        assert!(credentials_may_follow(&bare, &u("https://co.uk/dav/")));
        // Wildcard rules (`*.ck`) and their exceptions (`!www.ck`).
        assert_eq!(registrable_domain("a.b.ck").as_deref(), Some("a.b.ck"));
        assert_eq!(registrable_domain("x.www.ck").as_deref(), Some("www.ck"));
        // An unknown TLD falls back to the `*` rule: its own site per name.
        assert_eq!(registrable_domain("dav.home.lan").as_deref(), Some("home.lan"));
        assert!(!credentials_may_follow(&u("https://dav.home.lan/"), &u("https://nas.lan/")));
        // Case is not identity.
        assert!(credentials_may_follow(&from_upper(), &u("https://p42-caldav.example.com/")));
    }

    fn from_upper() -> Url {
        u("https://CalDAV.Example.COM/")
    }

    #[test]
    fn single_label_and_ip_hosts_match_only_exactly() {
        let local = u("https://nas/");
        assert_eq!(registrable_domain("nas"), None);
        assert!(credentials_may_follow(&local, &u("https://nas/dav/")));
        assert!(!credentials_may_follow(&local, &u("https://dav.nas/")));
        assert!(!credentials_may_follow(&u("https://localhost:5232/"), &u("https://sub.localhost:5232/")));

        let v4 = u("https://192.0.2.10/dav/");
        assert!(credentials_may_follow(&v4, &u("https://192.0.2.10/other")));
        assert!(!credentials_may_follow(&v4, &u("https://192.0.2.11/")));
        assert!(!credentials_may_follow(&v4, &u("https://192.0.2.10.example.com/")));
        let v6 = u("https://[2001:db8::1]/dav/");
        assert!(credentials_may_follow(&v6, &u("https://[2001:db8::1]/x")));
        assert!(!credentials_may_follow(&v6, &u("https://[2001:db8::2]/")));
        // A domain account never covers an IP, nor the other way round.
        assert!(!credentials_may_follow(&u("https://dav.example.com/"), &u("https://192.0.2.10/")));
        // A trailing-dot spelling fails closed.
        assert!(!credentials_may_follow(&u("https://dav.example.com./"), &u("https://p1.example.com./")));
    }

    #[test]
    fn an_http_ref_on_the_same_host_has_an_https_twin_and_nothing_else_does() {
        let origin = u("https://dav.example.com/");
        assert_eq!(
            https_twin("http://dav.example.com/cal/home/", &origin).as_deref(),
            Some("https://dav.example.com/cal/home/")
        );
        assert_eq!(
            https_twin("http://DAV.example.com:80/cal/", &origin).as_deref(),
            Some("https://dav.example.com/cal/")
        );
        // The account's own port, whatever the http one was.
        let odd = u("https://dav.example.com:8443/");
        assert_eq!(
            https_twin("http://dav.example.com:5232/cal/", &odd).as_deref(),
            Some("https://dav.example.com:8443/cal/")
        );
        assert_eq!(https_twin("http://other.example.com/cal/", &origin), None);
        assert_eq!(https_twin("https://dav.example.com/cal/", &origin), None);
        assert_eq!(https_twin("not a url", &origin), None);
        assert_eq!(https_twin("http://dav.example.com/cal/", &u("http://dav.example.com/")), None);
    }

    #[test]
    fn credentials_never_ride_a_hop_off_tls() {
        assert!(!credentials_may_follow(
            &u("https://example.org/.well-known/caldav"),
            &u("http://caldav.example.org/dav/")
        ));
        // A self-hosted plaintext server keeps working *on its own origin* —
        // that is the localhost/Radicale case `normalize_base_url` honours — but
        // it earns no subdomain latitude, since the header is readable anyway.
        let local = u("http://localhost:5232/");
        assert!(credentials_may_follow(
            &local,
            &u("http://localhost:5232/dav/")
        ));
        assert!(!credentials_may_follow(
            &local,
            &u("http://sub.localhost:5232/")
        ));
    }

    #[test]
    fn a_resource_name_is_a_single_safe_path_segment() {
        assert_eq!(resource_name("abc-123").unwrap(), "abc-123.ics");
        // A UID out of an imported file is text somebody else wrote.
        assert_eq!(resource_name("../../etc/passwd").unwrap(), "etc-passwd.ics");
        assert_eq!(resource_name("a b?c#d").unwrap(), "a-b-c-d.ics");
        // `..` is the name that must never reach a URL join, and the refusal has
        // to carry a sentence rather than be a bare error.
        assert!(!resource_name("..").unwrap_err().is_empty());
        assert!(resource_name("").is_err());
        assert!(resource_name("///").is_err());
        // Bounded, so a pathological UID cannot become a pathological URL.
        assert!(resource_name(&"x".repeat(4000)).unwrap().len() <= 124);
    }

    #[tokio::test]
    async fn an_update_with_no_known_etag_is_refused_rather_than_sent_blind() {
        // **The** rule of the write half, and the one a "make it work" fix would
        // quietly remove: there is no unconditional `PUT`, not even as a fallback
        // for a server that returned no validator. The unconditional write is
        // precisely the one that destroys an edit made from a phone between the
        // read and the write, and does it silently.
        //
        // This reaches no network: the refusal happens while building the
        // condition header, before a client is even used.
        let cred = cred("https://dav.example.org/dav/");
        let err = put_resource(
            "https://dav.example.org/dav/me/personal/e1.ics",
            &cred,
            "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
            WriteCondition::Update(String::new()),
        )
        .await
        .unwrap_err();
        assert!(err.contains("sync the calendar"), "{err}");

        // A delete is the same rule: no ETag, no request.
        let err = delete_resource(
            "https://dav.example.org/dav/me/personal/e1.ics",
            &cred,
            "  ",
        )
        .await
        .unwrap_err();
        assert!(err.contains("sync the calendar"), "{err}");
    }

    #[test]
    fn a_new_resource_lands_inside_its_collection() {
        assert_eq!(
            resource_url("https://dav.example.org/dav/me/personal/", "evt-1").unwrap(),
            "https://dav.example.org/dav/me/personal/evt-1.ics"
        );
        // A collection href without the trailing slash must not put the resource
        // *beside* the collection.
        assert_eq!(
            resource_url("https://dav.example.org/dav/me/personal", "evt-1").unwrap(),
            "https://dav.example.org/dav/me/personal/evt-1.ics"
        );
        // And a traversal-shaped uid cannot climb out of it.
        let out = resource_url("https://dav.example.org/dav/me/personal/", "../../x").unwrap();
        assert!(
            out.starts_with("https://dav.example.org/dav/me/personal/"),
            "{out}"
        );
    }

    #[test]
    fn status_lines_yield_their_code() {
        assert_eq!(status_code("HTTP/1.1 200 OK"), Some(200));
        assert_eq!(status_code("HTTP/1.1 404 Not Found"), Some(404));
        assert_eq!(status_code("nonsense"), None);
    }

    #[test]
    fn credentials_never_print_the_password() {
        let cred = Credentials::new(
            "someone".into(),
            "hunter2".into(), // privacy-check: ok — test fixture, never sent
            "https://dav.example.org/",
        )
        .unwrap();
        let shown = format!("{cred:?}");
        assert!(!shown.contains("hunter2"), "{shown}");
    }

    // ── The in-process transport (gap 26 / E2b tests) ──────────────────────
    //
    // `Dav::send` asks [`fake::answer`] first under `cfg(test)`. A thread-local
    // handler is safe here: `#[tokio::test]` runs each test on one thread.

    pub mod fake {
        use super::super::{StatusCode, Wire};
        use std::cell::RefCell;
        use std::sync::{Arc, Mutex};

        /// One request as the fake server saw it.
        #[derive(Debug, Clone)]
        pub struct Seen {
            pub method: String,
            pub url: String,
            pub auth: bool,
            pub body: String,
        }

        type Handler = Arc<dyn Fn(&Seen) -> Wire + Send + Sync>;
        type Log = Arc<Mutex<Vec<Seen>>>;

        thread_local! {
            static HANDLER: RefCell<Option<(Handler, Log)>> = const { RefCell::new(None) };
        }

        pub fn answer(req: &reqwest::Request) -> Option<Wire> {
            HANDLER.with(|slot| {
                let slot = slot.borrow();
                let (handler, log) = slot.as_ref()?;
                let seen = Seen {
                    method: req.method().as_str().to_string(),
                    url: req.url().to_string(),
                    auth: req.headers().contains_key(reqwest::header::AUTHORIZATION),
                    body: req
                        .body()
                        .and_then(|b| b.as_bytes())
                        .map(|b| String::from_utf8_lossy(b).into_owned())
                        .unwrap_or_default(),
                };
                log.lock().unwrap().push(seen.clone());
                Some(handler(&seen))
            })
        }

        /// Uninstalls the handler when dropped.
        pub struct Server(Log);

        impl Server {
            pub fn seen(&self) -> Vec<Seen> {
                self.0.lock().unwrap().clone()
            }
            /// Every request that reached a host.
            pub fn to_host(&self, host: &str) -> Vec<Seen> {
                self.seen()
                    .into_iter()
                    .filter(|s| reqwest::Url::parse(&s.url).unwrap().host_str() == Some(host))
                    .collect()
            }
        }

        impl Drop for Server {
            fn drop(&mut self) {
                HANDLER.with(|slot| *slot.borrow_mut() = None);
            }
        }

        pub fn serve(handler: impl Fn(&Seen) -> Wire + Send + Sync + 'static) -> Server {
            let log: Log = Arc::default();
            HANDLER.with(|slot| *slot.borrow_mut() = Some((Arc::new(handler), log.clone())));
            Server(log)
        }

        pub fn reply(status: u16, body: &str) -> Wire {
            Wire {
                status: StatusCode::from_u16(status).unwrap(),
                location: None,
                etag: String::new(),
                body: body.as_bytes().to_vec(),
            }
        }

        pub fn redirect(to: &str) -> Wire {
            Wire {
                status: StatusCode::TEMPORARY_REDIRECT,
                location: Some(to.to_string()),
                etag: String::new(),
                body: Vec::new(),
            }
        }
    }

    fn cred(origin: &str) -> Credentials {
        Credentials::new(
            "me".into(),
            "pw".into(), // privacy-check: ok — test fixture, reaches no network
            origin,
        )
        .unwrap()
    }

    /// A Depth-0 probe answer naming a principal and/or a home set.
    fn probe(principal: Option<&str>, home: Option<&str>) -> String {
        let mut props = String::new();
        if let Some(p) = principal {
            props.push_str(&format!(
                "<d:current-user-principal><d:href>{p}</d:href></d:current-user-principal>"
            ));
        }
        if let Some(h) = home {
            props.push_str(&format!("<c:calendar-home-set><d:href>{h}</d:href></c:calendar-home-set>"));
        }
        format!(
            r#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
<d:response><d:href>/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype>{props}</d:prop>
<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"#
        )
    }

    /// A home listing with one calendar per href.
    fn listing(hrefs: &[&str]) -> String {
        let mut out = String::from(
            r#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">"#,
        );
        for h in hrefs {
            out.push_str(&format!(
                r#"<d:response><d:href>{h}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>C</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"#
            ));
        }
        out.push_str("</d:multistatus>");
        out
    }

    /// A `calendar-query` answer with one resource per href.
    fn resources(hrefs: &[&str]) -> String {
        let mut out = String::from(
            r#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">"#,
        );
        for h in hrefs {
            out.push_str(&format!(
                r#"<d:response><d:href>{h}</d:href><d:propstat><d:prop><d:getetag>"e1"</d:getetag><c:calendar-data>BEGIN:VCALENDAR
END:VCALENDAR</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"#
            ));
        }
        out.push_str("</d:multistatus>");
        out
    }

    #[tokio::test]
    async fn a_principal_on_another_host_is_refused_before_any_request_reaches_it() {
        let server = fake::serve(|req| {
            if req.url.starts_with("https://dav.example.org/") {
                fake::reply(207, &probe(Some("https://evil.example.net/principals/me/"), None))
            } else {
                fake::reply(207, &listing(&["/cal/"]))
            }
        });
        let err = discover("https://dav.example.org/dav/", &cred("https://dav.example.org/dav/"))
            .await
            .unwrap_err();
        assert!(err.contains("evil.example.net"), "{err}");
        assert!(server.to_host("evil.example.net").is_empty(), "{:?}", server.seen());
        assert!(server.seen().iter().all(|s| s.auth), "every request went to the origin");
    }

    #[tokio::test]
    async fn an_icloud_shaped_principal_on_a_sibling_host_signs_in() {
        // Decision 2026-10-13: the account names `caldav.example.com`, the
        // server answers with a per-user sibling; same registrable domain, so
        // the login follows and the calendars there are listed.
        let server = fake::serve(|req| {
            if req.url.starts_with("https://caldav.example.com/") {
                fake::reply(207, &probe(Some("https://p42-caldav.example.com/42/principal/"), None))
            } else if req.url.contains("/principal/") {
                fake::reply(207, &probe(None, Some("https://p42-caldav.example.com/42/calendars/")))
            } else {
                fake::reply(207, &listing(&["/42/calendars/home/"]))
            }
        });
        let found = discover("https://caldav.example.com/", &cred("https://caldav.example.com/"))
            .await
            .unwrap();
        assert!(
            found.iter().any(|c| c.href == "https://p42-caldav.example.com/42/calendars/home/"),
            "{found:?}"
        );
        assert!(!server.to_host("p42-caldav.example.com").is_empty());
        assert!(server.seen().iter().all(|s| s.auth), "{:?}", server.seen());
    }

    #[tokio::test]
    async fn a_home_set_on_another_host_is_refused_before_any_request_reaches_it() {
        let server = fake::serve(|_| {
            fake::reply(207, &probe(None, Some("https://evil.example.net/home/")))
        });
        let err = discover("https://dav.example.org/", &cred("https://dav.example.org/"))
            .await
            .unwrap_err();
        assert!(err.contains("evil.example.net"), "{err}");
        assert!(server.to_host("evil.example.net").is_empty());
    }

    #[tokio::test]
    async fn a_redirect_target_naming_itself_principal_never_gets_the_password() {
        // Gap 26 (a): the host a redirect reached is asked without credentials,
        // and naming itself as the principal does not make it the origin.
        let server = fake::serve(|req| {
            if req.url.starts_with("https://dav.example.org/") {
                fake::redirect("https://evil.example.net/dav/")
            } else {
                fake::reply(207, &probe(Some("https://evil.example.net/principals/me/"), None))
            }
        });
        let err = discover("https://dav.example.org/dav/", &cred("https://dav.example.org/dav/"))
            .await
            .unwrap_err();
        assert!(err.contains("evil.example.net"), "{err}");
        let evil = server.to_host("evil.example.net");
        assert!(!evil.is_empty(), "the redirect itself is followed");
        assert!(evil.iter().all(|s| !s.auth), "{evil:?}");
        assert!(
            evil.iter().all(|s| !s.url.contains("/principals/")),
            "the self-named principal is never requested: {evil:?}"
        );
    }

    #[tokio::test]
    async fn the_well_known_hop_into_a_subdomain_still_signs_in() {
        let server = fake::serve(|req| match req.url.as_str() {
            "https://example.org/" => fake::reply(404, ""),
            "https://example.org/.well-known/caldav" => fake::redirect("https://caldav.example.org/"),
            "https://caldav.example.org/" => fake::reply(207, &probe(Some("/p/me/"), None)),
            "https://caldav.example.org/p/me/" => fake::reply(207, &probe(None, Some("/home/"))),
            _ => fake::reply(207, &listing(&["/home/work/", "https://other.example.net/x/"])),
        });
        let found = discover("https://example.org/", &cred("https://example.org/")).await.unwrap();
        assert_eq!(found.len(), 1, "the off-origin calendar is dropped: {found:?}");
        assert_eq!(found[0].href, "https://caldav.example.org/home/work/");
        assert!(server.seen().iter().all(|s| s.auth));
    }

    #[tokio::test]
    async fn a_listing_whose_calendars_all_sit_elsewhere_says_so() {
        let _server = fake::serve(|_| {
            fake::reply(207, &listing(&["https://evil.example.net/cal/", "http://dav.example.org/cal/"]))
        });
        let err = list_collections(
            &client().unwrap(),
            &Url::parse("https://dav.example.org/home/").unwrap(),
            &cred("https://dav.example.org/"),
        )
        .await
        .unwrap_err();
        assert!(err.contains("evil.example.net"), "{err}");
    }

    #[tokio::test]
    async fn stored_hrefs_outside_the_origin_get_no_request() {
        let server = fake::serve(|_| fake::reply(207, &resources(&[])));
        let cred = cred("https://dav.example.org/dav/");
        // A collection on another host (gap 26), and one on http under an
        // https origin (gap 26 (b), E2b).
        let off = "https://evil.example.net/cal/";
        let plain = "http://dav.example.org/dav/cal/";
        assert!(fetch_all(off, &cred, &[]).await.unwrap_err().contains("evil.example.net"));
        assert!(fetch_all(plain, &cred, &[]).await.unwrap_err().starts_with(HTTP_REFUSED));
        assert!(fetch_changes(off, &cred, "t").await.is_err());
        assert!(change_tokens(plain, &cred).await.is_err());
        assert!(collection_read_only(off, &cred).await.is_err());
        let put = put_resource(
            &format!("{off}e.ics"),
            &cred,
            "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
            WriteCondition::Create,
        )
        .await;
        assert!(put.is_err());
        assert!(delete_resource(&format!("{plain}e.ics"), &cred, "\"e\"").await.is_err());
        assert_eq!(current_etag(&format!("{off}e.ics"), &cred).await.unwrap(), "");
        assert!(server.seen().is_empty(), "nothing was sent: {:?}", server.seen());
    }

    #[tokio::test]
    async fn resources_outside_the_origin_are_never_stored() {
        // Not dropped either: a full listing is authoritative, so a dropped
        // resource would delete its local copy behind a "synced" status. The
        // read fails, naming the host.
        let _server = fake::serve(|req| {
            if req.body.contains("calendar-query") {
                fake::reply(207, &resources(&["/dav/cal/ok.ics", "https://evil.example.net/x.ics"]))
            } else {
                fake::reply(207, &listing(&[]))
            }
        });
        let err = fetch_all(
            "https://dav.example.org/dav/cal/",
            &cred("https://dav.example.org/dav/"),
            &["VEVENT".to_string()],
        )
        .await
        .unwrap_err();
        assert!(err.contains("evil.example.net"), "{err}");
    }

    #[tokio::test]
    async fn a_listing_of_http_entries_fails_the_sync_instead_of_emptying_the_calendar() {
        // A TLS proxy in front of a server that builds absolute `http://` hrefs:
        // every entry is outside the origin. Read as "nothing there", the merge
        // would delete every local row and call it a success.
        let _server = fake::serve(|req| {
            if req.body.contains("calendar-query") {
                fake::reply(
                    207,
                    &resources(&["http://dav.example.org/dav/cal/a.ics", "http://dav.example.org/dav/cal/b.ics"]),
                )
            } else {
                fake::reply(207, &listing(&[]))
            }
        });
        let cred = cred("https://dav.example.org/dav/");
        let err = fetch_all("https://dav.example.org/dav/cal/", &cred, &["VEVENT".to_string()])
            .await
            .unwrap_err();
        assert!(err.starts_with(HTTP_REFUSED), "{err}");
    }

    #[tokio::test]
    async fn a_read_redirected_off_the_origin_fails_rather_than_reading_empty() {
        // A read may follow a redirect bare; what that host lists resolves
        // against it and is outside the origin — an error, not an empty listing.
        let server = fake::serve(|req| {
            if req.url.starts_with("https://dav.example.org/") {
                fake::redirect("https://elsewhere.example.net/cal/")
            } else {
                fake::reply(207, &resources(&["/cal/a.ics"]))
            }
        });
        let err = fetch_all(
            "https://dav.example.org/dav/cal/",
            &cred("https://dav.example.org/dav/"),
            &["VEVENT".to_string()],
        )
        .await
        .unwrap_err();
        assert!(err.contains("elsewhere.example.net"), "{err}");
        assert!(server.to_host("elsewhere.example.net").iter().all(|s| !s.auth));
    }

    #[test]
    fn a_deletion_stub_outside_the_origin_is_ignored() {
        let xml = r#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
<d:response><d:href>https://evil.example.net/x.ics</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>
<d:response><d:href>/dav/cal/gone.ics</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>
<d:sync-token>t2</d:sync-token></d:multistatus>"#;
        let base = u("https://dav.example.org/dav/cal/");
        let got = changes_from(&base, &base, &parse_multistatus(xml).unwrap(), true).unwrap();
        assert_eq!(got.removed, ["https://dav.example.org/dav/cal/gone.ics"]);
    }

    #[tokio::test]
    async fn a_redirect_to_http_is_refused_outright() {
        let server = fake::serve(|req| {
            if req.url.starts_with("https://") {
                fake::redirect("http://dav.example.org/dav/cal/")
            } else {
                fake::reply(207, &resources(&[]))
            }
        });
        let err = fetch_all("https://dav.example.org/dav/cal/", &cred("https://dav.example.org/dav/"), &[])
            .await
            .unwrap_err();
        assert!(err.starts_with(HTTP_REFUSED), "{err}");
        assert!(server.seen().iter().all(|s| s.url.starts_with("https://")));
    }

    #[tokio::test]
    async fn a_write_redirected_off_the_origin_is_refused_not_sent_bare() {
        // A redirected PUT would carry the event itself to the other host.
        let server = fake::serve(|req| {
            if req.url.starts_with("https://dav.example.org/") {
                fake::redirect("https://evil.example.net/e.ics")
            } else {
                fake::reply(201, "")
            }
        });
        let err = put_resource(
            "https://dav.example.org/dav/cal/e.ics",
            &cred("https://dav.example.org/dav/"),
            "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
            WriteCondition::Create,
        )
        .await
        .unwrap_err();
        assert!(err.contains("evil.example.net"), "{err}");
        assert!(server.to_host("evil.example.net").is_empty());
        assert!(server.seen().iter().all(|s| s.method == "PUT" && s.auth));
    }

    #[test]
    fn an_http_account_has_no_credentials_and_hrefs_check_the_origin() {
        let err = Credentials::new("me".into(), "x".into(), "http://dav.example.org/").unwrap_err();
        assert!(err.starts_with(HTTP_REFUSED), "{err}");
        let origin = u("https://example.org/");
        assert!(href_in_origin(&origin, "https://example.org/cal/"));
        assert!(href_in_origin(&origin, "https://caldav.example.org/cal/"));
        assert!(!href_in_origin(&origin, "http://example.org/cal/"));
        assert!(!href_in_origin(&origin, "https://example.net/cal/"));
        assert!(!href_in_origin(&origin, "https://evilexample.org/cal/"));
        assert!(!href_in_origin(&origin, "not a url"));
    }

    #[tokio::test]
    async fn the_real_client_refuses_plain_http_before_connecting() {
        // The `https_only` backstop: a refusal at build time, not a connect
        // error (which is what the same request gets without it).
        let dav = client().unwrap();
        let req = dav.client.get("http://127.0.0.1:9/").build().unwrap();
        let err = dav.client.execute(req).await.unwrap_err();
        assert!(err.is_builder(), "{err:?}");
    }

    #[test]
    fn the_client_builds() {
        // Proves the crypto provider is installed before rustls is first used:
        // rustls 0.23 panics rather than erroring when none is, and that panic
        // would happen on a user's machine at their first sync.
        client().unwrap();
    }
}

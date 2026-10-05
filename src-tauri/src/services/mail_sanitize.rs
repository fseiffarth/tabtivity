//! HTML sanitization and filename sanitization for the mail client.
//!
//! **Sanitization happens in Rust, in the backend, once, before IPC** (plan B
//! §2.1). The argument is structural rather than about discipline: a frontend
//! sanitizer means the raw attacker HTML is already inside the app origin as a
//! JS string when sanitization runs, so any bug in the surrounding code — a
//! stray log, a devtools hook, a refactor that renders before sanitizing — is
//! app-origin XSS with full Tauri IPC. Sanitizing here means the unsanitized
//! string never exists in the webview process at all.
//!
//! Ammonia specifically, because it parses with html5ever — the same HTML5 tree
//! construction the renderer uses — and re-serializes *from the tree*. Regex and
//! string sanitizers fail on mutation-XSS precisely because they do not share
//! the renderer's parse.
//!
//! Three properties this module guarantees about its output, each with a test:
//!
//! - **No `href` survives anywhere.** Every `<a>` becomes `<a data-lid="N">`,
//!   and the real URL only ever reaches the frontend as a row in
//!   [`SanitizedBody::links`]. That makes the entire display-text-vs-href
//!   phishing class structurally impossible rather than filtered (plan B §2.5).
//! - **No attribute can load anything remote.** `src`, `srcset`, `poster`,
//!   `background`, `data`, … are not in the allowlist at all, and the
//!   `attribute_filter` rejects them a second time.
//! - **`script`/`style`/`title`/`noscript`/… are removed with their contents**
//!   (ammonia's `clean_content_tags`) — the contents of those elements are
//!   re-parsed differently by the renderer and are the classic mXSS payload site.
//!
//! The frontend renders the result in an `<iframe sandbox="" srcdoc=…>` with its
//! own `default-src 'none'` CSP. That is a *third* layer; nothing here may rely
//! on it.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use crate::schema::mail::MailLink;

/// Bumped **by hand** whenever anything in this module's builder configuration
/// changes. `bodies_cache` rows are keyed by it, so a sanitizer fix
/// retroactively re-protects already-synced mail instead of serving a body that
/// was cleaned by the old rules. Changing the allowlists below without bumping
/// this is a bug.
///
/// It keys the cache for the **whole** body pipeline, not only this module's
/// builder: `bodies_cache` stores what `parse_message` → `sanitize_message_html`
/// produced together, so a fix anywhere along that path needs a bump or the
/// pre-fix artifact keeps being served. Version 2 is the pair of
/// `mail_engine` fixes — the UTF-7 charset gate missing the two labels
/// `mail-parser` actually decodes, and `text/plain` bodies being handed to the
/// HTML renderer — neither of which touches the allowlists below. Version 3 is
/// the link table: hosts parsed the way a browser parses them (`\\` is `/`),
/// every host the link text names checked, punycode shown in both forms, and
/// `data-lid` found only inside tags — plus bodies with a crypto verdict no
/// longer cached, which drops the old verdict-less copies.
pub const SANITIZER_VERSION: u32 = 3;

/// Largest HTML body handed to the sanitizer. Over this the message is refused
/// with a typed error rather than parsed (plan B §3.6).
pub const MAX_HTML_BYTES: usize = 5 * 1024 * 1024;

/// Element budget of the sanitized output. Over this the body is truncated with
/// a marker. This is a **WebKitGTK responsiveness** requirement as much as a
/// security one: the message frame renders on the same GTK main loop as
/// Tabtivity's UI, so a 100k-node body janks the whole window (plan B §2.8).
pub const MAX_ELEMENTS: usize = 20_000;

/// Nesting budget of the *input*, enforced before the parser sees it.
///
/// This one is not in the plan and is load-bearing anyway: html5ever's tree
/// construction is iterative (so a deep body cannot overflow the stack), but
/// ammonia's own clean is quadratic in nesting depth — measured, 20 000 nested
/// `<div>`s cost ~0.8 s in release and minutes in a debug build, which is
/// exactly the "one message wedges the tab" failure the caps exist to prevent.
/// Real mail nests tables perhaps 15 deep, so 64 is generous.
pub const MAX_NESTING: usize = 64;

/// Wall-clock bound on one sanitize. Checked after the fact — a true preemptive
/// watchdog needs a separate process, which is plan A's Phase-5 helper. The
/// size and element caps are what actually keep the runtime bounded; this only
/// turns a pathological outlier into a typed error instead of a frozen tab.
pub const MAX_SANITIZE: std::time::Duration = std::time::Duration::from_secs(5);

/// Longest anchor display text kept for the link table.
const MAX_LINK_TEXT: usize = 200;

/// What the frontend gets back. `html` is a **fragment**; the srcdoc wrapper
/// (its `<meta>` CSP, its reset CSS) is assembled in the frontend next to the
/// iframe it protects.
#[derive(Debug, Clone, Default)]
pub struct SanitizedBody {
    pub html: String,
    pub links: Vec<MailLink>,
    /// How many remote references were dropped, for the "Tabtivity blocked n
    /// remote images" banner.
    pub remote_refs: u32,
    pub truncated: bool,
}

/// Why a body could not be sanitized. Typed so the caller can say something
/// specific instead of rendering nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SanitizeError {
    /// Body exceeded [`MAX_HTML_BYTES`].
    TooLarge { bytes: usize },
    /// Sanitizing took longer than [`MAX_SANITIZE`].
    Timeout,
}

impl std::fmt::Display for SanitizeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SanitizeError::TooLarge { bytes } => write!(
                f,
                "message body is too large to display ({bytes} bytes; limit {MAX_HTML_BYTES})"
            ),
            SanitizeError::Timeout => {
                write!(
                    f,
                    "message body took too long to sanitize and was not rendered"
                )
            }
        }
    }
}

// ── Allowlists ──────────────────────────────────────────────────────────────

/// Tags kept, **replacing ammonia's default entirely** (`Builder::tags`, not
/// `add_tags`) so a future ammonia default change cannot widen us.
const ALLOWED_TAGS: &[&str] = &[
    "a",
    "abbr",
    "b",
    "blockquote",
    "br",
    "caption",
    "cite",
    "code",
    "col",
    "colgroup",
    "dd",
    "del",
    "dfn",
    "div",
    "dl",
    "dt",
    "em",
    "figcaption",
    "figure",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "i",
    "img",
    "ins",
    "kbd",
    "li",
    "mark",
    "ol",
    "p",
    "pre",
    "q",
    "s",
    "samp",
    "small",
    "span",
    "strong",
    "sub",
    "sup",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "u",
    "ul",
    "var",
    "wbr",
];

/// Removed **with their contents**. The contents of `<style>`/`<title>`/
/// `<noscript>`/`<template>`/`<xmp>` are re-parsed under different rules by the
/// renderer and are where the canonical mXSS payloads live, so stripping only
/// the tag would leave the payload as text that re-parses into markup.
const CLEAN_CONTENT_TAGS: &[&str] = &[
    "script", "style", "title", "textarea", "noscript", "iframe", "object", "embed", "template",
    "xmp",
];

/// CSS properties that may survive inside a `style=` attribute. Deliberately
/// excluded: `position`, `top`/`right`/`bottom`/`left`, `z-index` (fake app
/// chrome overlays), `content`, `background` (the shorthand can carry `url()`),
/// `background-image`, `cursor`, `filter`, `transform`, `transition`,
/// `animation`, `clip-path`, `mask`, `mix-blend-mode`, `opacity`, `float`,
/// `pointer-events`, and every vendor-prefixed property.
const ALLOWED_STYLE_PROPERTIES: &[&str] = &[
    "color",
    "background-color",
    "font-family",
    "font-size",
    "font-style",
    "font-weight",
    "font-variant",
    "text-align",
    "text-decoration",
    "text-transform",
    "letter-spacing",
    "line-height",
    "white-space",
    "word-break",
    "overflow-wrap",
    "vertical-align",
    "margin",
    "margin-top",
    "margin-right",
    "margin-bottom",
    "margin-left",
    "padding",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "border",
    "border-top",
    "border-right",
    "border-bottom",
    "border-left",
    "border-color",
    "border-style",
    "border-width",
    "border-radius",
    "border-collapse",
    "border-spacing",
    "width",
    "max-width",
    "height",
    "max-height",
    "display",
    "list-style-type",
];

/// Values `display:` may take. Anything else drops the whole declaration —
/// `display` itself is harmless but `display: -webkit-box` and friends are a
/// vendor-behaviour surface with no legitimate use in a mail body.
const ALLOWED_DISPLAY_VALUES: &[&str] = &[
    "inline",
    "block",
    "inline-block",
    "table",
    "table-row",
    "table-cell",
    "list-item",
    "none",
];

/// Attribute names refused outright by the `attribute_filter`, on top of not
/// being in any tag's allowlist. Belt and braces: every one of these can load
/// or navigate.
const BANNED_ATTRIBUTES: &[&str] = &[
    "src",
    "href",
    "xlink:href",
    "srcset",
    "formaction",
    "action",
    "data",
    "poster",
    "background",
    "codebase",
    "usemap",
    "ping",
    "dynsrc",
    "lowsrc",
];

/// URL schemes an `<a href>` may carry *into the link table*. Anything else is
/// dropped by ammonia before our filter ever sees it, so a `javascript:` or
/// `data:` anchor ends up with no attributes at all and no table row — strictly
/// safer than recording it.
const LINK_SCHEMES: &[&str] = &[
    "http", "https", "mailto", "ftp", "ftps", "tel", "sms", "news", "nntp", "xmpp", "irc", "ircs",
];

/// Schemes the frontend may offer an "Open" affordance for. Everything else
/// gets a `scheme_warning` and is copy-only.
const WEB_SCHEMES: &[&str] = &["http", "https", "mailto"];

// ── The link collector ──────────────────────────────────────────────────────

/// Hrefs seen by the `attribute_filter`, in document order. The filter is a
/// `Fn + Send + Sync + 'static` closure, so the collector is shared through an
/// `Arc<Mutex<…>>`; one is minted per call, which is also why the builder is
/// built per call rather than cached in a `OnceLock`.
#[derive(Default)]
struct LinkCollector {
    hrefs: Vec<String>,
    /// Remote URLs seen in an attribute the filter *did* get to inspect.
    dropped_remote: u32,
}

// ── The pipeline ────────────────────────────────────────────────────────────

/// Sanitize one `text/html` message body.
///
/// Returns a fragment with no `href`, no remote-loading attribute, no `script`
/// or `style` element, and a link table the frontend renders as a separate,
/// explicitly-confirmed clickable surface.
pub fn sanitize_message_html(raw: &str) -> Result<SanitizedBody, SanitizeError> {
    sanitize_within(raw, MAX_SANITIZE)
}

/// [`sanitize_message_html`] with the wall-clock budget as a parameter, so the
/// complexity tests can bound CPU time instead: a parallel `cargo test` can
/// leave this thread runnable but off-CPU for seconds.
fn sanitize_within(raw: &str, budget: std::time::Duration) -> Result<SanitizedBody, SanitizeError> {
    if raw.len() > MAX_HTML_BYTES {
        return Err(SanitizeError::TooLarge { bytes: raw.len() });
    }
    let started = std::time::Instant::now();

    let remote_refs = count_remote_refs(raw);
    let (bounded, pre_truncated) = bound_raw(raw);
    let raw = bounded.as_ref();
    let collector: Arc<Mutex<LinkCollector>> = Arc::new(Mutex::new(LinkCollector::default()));

    let cleaned = {
        let sink = collector.clone();
        let mut builder = ammonia::Builder::default();
        builder
            .tags(ALLOWED_TAGS.iter().copied().collect::<HashSet<_>>())
            .clean_content_tags(CLEAN_CONTENT_TAGS.iter().copied().collect::<HashSet<_>>())
            // Empty: `title` is not generic, and `lang`/`dir` are handled per tag.
            .generic_attributes(HashSet::new())
            .tag_attributes(tag_attributes())
            .tag_attribute_values(tag_attribute_values())
            .url_schemes(LINK_SCHEMES.iter().copied().collect::<HashSet<_>>())
            // PassThrough rather than Deny **only** because every URL-bearing
            // attribute that survives the allowlist is `a href`, and the filter
            // below rewrites every one of those to an integer index which is
            // then renamed to `data-lid`. Nothing relative reaches the output.
            .url_relative(ammonia::UrlRelative::PassThrough)
            .strip_comments(true)
            .id_prefix(Some("m-"))
            .link_rel(None)
            .filter_style_properties(
                ALLOWED_STYLE_PROPERTIES
                    .iter()
                    .copied()
                    .collect::<HashSet<_>>(),
            )
            .attribute_filter(move |element, attribute, value| {
                filter_attribute(&sink, element, attribute, value)
            });
        builder.clean(raw).to_string()
    };

    // Rename the placeholder we smuggled through ammonia's URL machinery.
    let mut html = rename_anchor_hrefs(&cleaned);

    let hrefs = {
        let guard = collector.lock().map_err(|_| SanitizeError::Timeout)?;
        guard.hrefs.clone()
    };

    let mut truncated = pre_truncated;
    if count_elements(&html) > MAX_ELEMENTS {
        html = truncate_elements(&html, MAX_ELEMENTS);
        truncated = true;
    }

    // Where each surviving anchor sits, found in ONE pass over the fragment.
    //
    // The obvious spelling — `html.contains(marker)` then `html.find(marker)`
    // per link — is O(links × bytes), and both caps are high enough for that to
    // be a hang rather than a slowdown: 19 000 anchors in a 4.5 MB body is two
    // full scans each, ~170 GB of searching, **9 s in a release build** (and the
    // `MAX_SANITIZE` check below is after the fact, so it converts the hang into
    // a typed error only once the time is already spent). Worse, a body that
    // times out is never cached, so every re-open pays it again.
    let positions = lid_positions(&html);
    let mut links = Vec::with_capacity(hrefs.len());
    for (lid, href) in hrefs.iter().enumerate() {
        // A link the truncation cut away must not appear in the panel.
        let Some(&at) = positions.get(&(lid as u32)) else {
            continue;
        };
        links.push(link_info(lid as u32, href, &anchor_text_at(&html, at)));
    }

    if started.elapsed() > budget {
        return Err(SanitizeError::Timeout);
    }

    Ok(SanitizedBody {
        html,
        links,
        remote_refs,
        truncated,
    })
}

/// Rename every anchor's `href` — which the `attribute_filter` has already
/// rewritten to a bare integer index — to `data-lid`, so no `href` survives.
///
/// A plain `replace("<a href=\"", …)` does **not** do this: html5ever
/// serializes attributes in *source* order, so `<a style="…" href="…">` comes
/// back as `<a style="…" href="0">` and the naive replace misses it. The
/// consequences were both real — the frontend's `bodyLooksUnsafe` tripwire sees
/// the surviving `href=` and refuses to render the whole message, and the link
/// never gets a `data-lid`, so it vanishes from the link panel too.
///
/// So the rename walks start tags instead. It only ever rewrites inside an `<a`
/// start tag, and only the literal ` href="` — which cannot occur inside an
/// attribute value, because html5ever escapes `"` there as `&quot;`, nor in a
/// text node, because it escapes `<` there as `&lt;`.
fn rename_anchor_hrefs(html: &str) -> String {
    let mut out = String::with_capacity(html.len() + 16);
    let mut rest = html;
    while let Some(pos) = rest.find("<a") {
        let after = &rest[pos + 2..];
        let is_start_tag = after
            .chars()
            .next()
            .map(|c| c == '>' || c == '/' || c.is_ascii_whitespace())
            .unwrap_or(false);
        if !is_start_tag {
            // `<abbr`, `<article`, … — copy through and keep looking.
            out.push_str(&rest[..pos + 2]);
            rest = after;
            continue;
        }
        out.push_str(&rest[..pos]);
        let end = after
            .find('>')
            .map(|e| pos + 2 + e + 1)
            .unwrap_or(rest.len());
        // `class="mail-link"` is added here, not carried from input (`class` is
        // in no allowlist, so the message cannot supply one). Without it the
        // frame's `.mail-link` rule matches nothing and every link in a body
        // renders as plain text — indistinguishable from the words around it,
        // with the links panel the only hint one exists at all.
        let tag = &rest[pos..end];
        out.push_str(&if tag.contains(" href=\"") {
            tag.replacen(" href=\"", " class=\"mail-link\" data-lid=\"", 1)
        } else {
            tag.to_string()
        });
        rest = &rest[end..];
    }
    out.push_str(rest);
    out
}

/// Wrap a `text/plain` body for display: escaped, never parsed as markup.
pub fn plain_text_to_html(text: &str) -> String {
    format!("<pre class=\"mail-plain\">{}</pre>", escape_text(text))
}

fn escape_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

fn tag_attributes() -> HashMap<&'static str, HashSet<&'static str>> {
    let mut map: HashMap<&'static str, HashSet<&'static str>> = HashMap::new();
    // `href` is the ONE URL attribute allowed through, and only so the filter
    // can record it and replace it with an index. It never survives as a URL.
    map.insert("a", ["href"].into_iter().collect());
    // Note the absence of `src`: an attacker-supplied image source never
    // survives, including a `data:` one they wrote themselves. Inline `cid:`
    // images are injected by our own pass, not permitted from input.
    map.insert("img", ["alt", "width", "height"].into_iter().collect());
    for tag in ["table", "td", "th", "tr"] {
        map.insert(tag, ["colspan", "rowspan"].into_iter().collect());
    }
    map.insert("ol", ["start"].into_iter().collect());
    for tag in ALLOWED_TAGS {
        map.entry(tag).or_default().insert("style");
    }
    map
}

fn tag_attribute_values() -> HashMap<&'static str, HashMap<&'static str, HashSet<&'static str>>> {
    let mut out: HashMap<&'static str, HashMap<&'static str, HashSet<&'static str>>> =
        HashMap::new();
    for tag in ALLOWED_TAGS {
        let mut attrs: HashMap<&'static str, HashSet<&'static str>> = HashMap::new();
        attrs.insert("dir", ["ltr", "rtl", "auto"].into_iter().collect());
        out.insert(tag, attrs);
    }
    out
}

/// The per-attribute belt to the allowlist's braces.
fn filter_attribute<'u>(
    sink: &Arc<Mutex<LinkCollector>>,
    element: &str,
    attribute: &str,
    value: &'u str,
) -> Option<Cow<'u, str>> {
    let name = attribute.to_ascii_lowercase();

    // Event handlers, whatever the tag. `on*` is checked by prefix rather than
    // by list because the list grows with every HTML spec revision.
    if name.starts_with("on") || name.chars().any(|c| c.is_control()) {
        return None;
    }

    // Every loading/navigating attribute, refused a second time.
    if BANNED_ATTRIBUTES.contains(&name.as_str()) && !(element == "a" && name == "href") {
        if looks_remote(value) {
            if let Ok(mut c) = sink.lock() {
                c.dropped_remote = c.dropped_remote.saturating_add(1);
            }
        }
        return None;
    }

    // The one URL that gets recorded: an anchor's target. It leaves as an
    // integer index, which the caller renames to `data-lid`.
    if element == "a" && name == "href" {
        let mut c = sink.lock().ok()?;
        let lid = c.hrefs.len();
        c.hrefs.push(value.to_string());
        return Some(Cow::Owned(lid.to_string()));
    }

    match name.as_str() {
        // Numeric-typed attributes: four digits is more than any real table
        // needs and stops `colspan=999999999` being a layout bomb.
        "colspan" | "rowspan" | "start" | "width" | "height" => {
            let v = value.trim();
            if !v.is_empty() && v.len() <= 4 && v.bytes().all(|b| b.is_ascii_digit()) {
                Some(Cow::Borrowed(value))
            } else {
                None
            }
        }
        "style" => Some(Cow::Owned(filter_style_value(value))),
        _ => Some(Cow::Borrowed(value)),
    }
}

/// Drop whole CSS declarations that carry a fetch, an escape, a comment, a
/// nested at-rule, or a non-ASCII character. Runs **before** ammonia's own
/// property allowlist (`filter_style_properties`), so a declaration has to
/// survive both.
fn filter_style_value(value: &str) -> String {
    let mut kept: Vec<String> = Vec::new();
    for decl in value.split(';') {
        let decl = decl.trim();
        if decl.is_empty() {
            continue;
        }
        let lower = decl.to_ascii_lowercase();
        if ["url(", "expression(", "@", "\\", "/*", "<", ">", "&"]
            .iter()
            .any(|bad| lower.contains(bad))
        {
            continue;
        }
        if !decl.is_ascii() {
            continue;
        }
        let Some((prop, val)) = decl.split_once(':') else {
            continue;
        };
        let prop = prop.trim().to_ascii_lowercase();
        let val = val.trim().to_ascii_lowercase();
        if prop == "display" && !ALLOWED_DISPLAY_VALUES.contains(&val.as_str()) {
            continue;
        }
        kept.push(decl.to_string());
    }
    kept.join("; ")
}

/// Does this attribute value point at something remote? Used only to count the
/// blocked-remote banner; it is not a security control (the attribute is
/// dropped either way).
fn looks_remote(value: &str) -> bool {
    let v = value.trim_start().to_ascii_lowercase();
    v.starts_with("http://") || v.starts_with("https://") || v.starts_with("//")
}

/// Count remote references in the **raw** body, for the blocked-images banner.
///
/// Deliberately a scan rather than a parse: the loading attributes are refused
/// by the tag allowlist *before* ammonia's `attribute_filter` runs, so there is
/// no hook that sees them all, and allowlisting `src` merely to count it would
/// trade a real guarantee for a nicer number. The count is advisory — the
/// guarantee is that none of them can load.
pub fn count_remote_refs(raw: &str) -> u32 {
    let lower = raw.to_ascii_lowercase();
    let mut n: u32 = 0;
    for needle in [
        "src=\"http",
        "src='http",
        "src=http",
        "srcset=\"http",
        "srcset='http",
        "background=\"http",
        "background='http",
        "poster=\"http",
        "poster='http",
        "url(http",
        "url(\"http",
        "url('http",
    ] {
        n = n.saturating_add(lower.matches(needle).count() as u32);
    }
    n
}

/// HTML elements that never open a nesting level.
const VOID_ELEMENTS: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source",
    "track", "wbr",
];

/// Cut hostile *input* down to something the parser can chew in bounded time,
/// before ammonia ever sees it.
///
/// A deliberately dumb byte scan rather than a parse — it runs on attacker bytes
/// and must not itself be a place where anything can go wrong. It over-counts
/// (a stray `<` in text looks like a tag) and under-counts (a malformed close
/// tag), which is fine: the only decision it makes is *where to stop reading*,
/// and stopping early is always safe.
fn bound_raw(raw: &str) -> (Cow<'_, str>, bool) {
    let bytes = raw.as_bytes();
    let mut depth: usize = 0;
    let mut tags: usize = 0;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'<' {
            i += 1;
            continue;
        }
        let next = bytes.get(i + 1).copied().unwrap_or(0);
        if next == b'/' {
            depth = depth.saturating_sub(1);
            tags += 1;
        } else if next.is_ascii_alphabetic() {
            let start = i + 1;
            let mut end = start;
            while end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'-') {
                end += 1;
            }
            let name = raw[start..end].to_ascii_lowercase();
            tags += 1;
            if !VOID_ELEMENTS.contains(&name.as_str()) {
                depth += 1;
            }
        } else {
            i += 1;
            continue;
        }
        if depth > MAX_NESTING || tags > MAX_ELEMENTS {
            return (Cow::Owned(raw[..i].to_string()), true);
        }
        i += 1;
    }
    (Cow::Borrowed(raw), false)
}

/// Number of element start tags in an already-serialized fragment.
fn count_elements(html: &str) -> usize {
    let bytes = html.as_bytes();
    let mut n = 0;
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'<' && bytes[i + 1].is_ascii_alphabetic() {
            n += 1;
        }
        i += 1;
    }
    n
}

/// Cut a serialized fragment at the `max`-th element start and append a marker.
///
/// The cut can leave elements unclosed; that is harmless here because every
/// allowed tag is inert and the browser's own parser closes them at the end of
/// the srcdoc. Re-running ammonia to rebalance would renumber `data-lid`s and
/// break the link table, which is a worse trade.
fn truncate_elements(html: &str, max: usize) -> String {
    let bytes = html.as_bytes();
    let mut n = 0;
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'<' && bytes[i + 1].is_ascii_alphabetic() {
            n += 1;
            if n > max {
                break;
            }
        }
        i += 1;
    }
    let mut cut = i.min(html.len());
    while cut > 0 && !html.is_char_boundary(cut) {
        cut -= 1;
    }
    let mut out = html[..cut].to_string();
    out.push_str("<p class=\"mail-truncated\">…</p>");
    out
}

/// Byte offset just past the closing quote of each `data-lid="N"` in the
/// fragment, for the first occurrence of each `N`.
///
/// Anchored on the `data-lid` attribute alone rather than on `<a data-lid=…>`:
/// html5ever serializes attributes in source order, so a real anchor comes back
/// as `<a style="…" data-lid="0">` or `<a data-lid="0" style="…">` just as often
/// as bare. Requiring a fixed position silently returned an empty display text
/// for every styled link — which is the input to the display-text-vs-host
/// mismatch check, i.e. phishing detection off for nearly every anchor in real
/// HTML mail. `data-lid` is minted here and is in no input allowlist, so it can
/// only be ours; the closing quote is required so `"1"` cannot match `"12"`.
fn lid_positions(html: &str) -> HashMap<u32, usize> {
    const NEEDLE: &[u8] = b"data-lid=\"";
    let bytes = html.as_bytes();
    let mut out: HashMap<u32, usize> = HashMap::new();
    // Only **inside a tag, outside a quoted value**. html5ever escapes `<` and
    // `>` in text but not `"`, so a literal `data-lid="0"` hidden in a message's
    // text (a `display:none` span before the real link) used to be found first
    // and read the link text from the wrong place — an empty text, and the
    // mismatch flag quietly off. Attribute values escape `"`, so tracking quotes
    // is enough to stay out of them too.
    let (mut in_tag, mut quote) = (false, None::<u8>);
    let mut i = 0usize;
    while i < bytes.len() {
        let b = bytes[i];
        match (in_tag, quote) {
            (false, _) => {
                if b == b'<' {
                    in_tag = true;
                }
            }
            (true, Some(q)) => {
                if b == q {
                    quote = None;
                }
            }
            (true, None) => {
                if b == b'>' {
                    in_tag = false;
                } else if b == b'"' || b == b'\'' {
                    quote = Some(b);
                } else if bytes[i..].starts_with(NEEDLE) && i > 0 && bytes[i - 1].is_ascii_whitespace() {
                    let digits_at = i + NEEDLE.len();
                    let rest = &html[digits_at..];
                    let end = rest
                        .bytes()
                        .position(|b| !b.is_ascii_digit())
                        .unwrap_or(rest.len());
                    // `data-lid=""` or a non-numeric value is not one of ours.
                    if end > 0 && rest.as_bytes().get(end) == Some(&b'"') {
                        if let Ok(lid) = rest[..end].parse::<u32>() {
                            out.entry(lid).or_insert(digits_at + end + 1);
                        }
                    }
                    // Inside the value now: its closing quote must close it.
                    quote = Some(b'"');
                    i = digits_at;
                    continue;
                }
            }
        }
        i += 1;
    }
    out
}

/// The visible text of the anchor whose `data-lid="N"` ends at byte `at`.
///
/// Reads the *output*, not the input, so it operates on bytes ammonia already
/// escaped.
fn anchor_text_at(html: &str, at: usize) -> String {
    let after = &html[at..];
    let Some(gt) = after.find('>') else {
        return String::new();
    };
    let rest = &after[gt + 1..];
    let end = rest.find("</a>").unwrap_or(rest.len());
    let inner = &rest[..end];

    let mut text = String::new();
    let mut in_tag = false;
    for c in inner.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => text.push(c),
            _ => {}
        }
        if text.len() > MAX_LINK_TEXT * 4 {
            break;
        }
    }
    let text = text
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ");
    let text: String = text.chars().filter(|c| !is_format_char(*c)).collect();
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    truncate_chars(&text, MAX_LINK_TEXT)
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect()
}

// ── Link classification ─────────────────────────────────────────────────────

/// Build one [`MailLink`] row from an href and the anchor's visible text.
pub fn link_info(lid: u32, href: &str, display_text: &str) -> MailLink {
    let scheme = scheme_of(href);
    let host = host_of(href);
    // An internationalized host is shown in both forms. Unicode alone is how
    // `xn--pypal-4ve.com` reads as "pаypal.com" (a Cyrillic а) with nothing to
    // tell the two apart; the ASCII form beside it is what differs visibly.
    let display_host = if host.is_empty() {
        scheme.clone()
    } else {
        let unicode = idna_display(&host);
        if unicode == host {
            unicode
        } else {
            format!("{unicode} ({host})")
        }
    };

    let scheme_warning = if WEB_SCHEMES.contains(&scheme.as_str()) {
        None
    } else if scheme.is_empty() {
        Some("no-scheme".to_string())
    } else {
        Some(scheme.clone())
    };

    // Userinfo (`https://bank.example@evil.example/`) is the classic
    // "the host is the part after the last @" confusion, so it always counts
    // as a mismatch whatever the text says.
    let userinfo = has_userinfo(href);
    let link_site = registrable(&host);
    let mismatch = userinfo
        || hosts_in_text(display_text)
            .iter()
            .any(|t| registrable(t) != link_site);

    MailLink {
        lid,
        href: href.to_string(),
        display_host,
        mismatch,
        scheme_warning,
    }
}

// ── Moved to `services::web_safety` ─────────────────────────────────────────
//
// The URL primitives and the filename sanitizer are shared with the in-app
// browser: a message chooses a filename and a host, and so does a web page, so
// there is exactly one implementation of "what is this really called" and "what
// host is this really on". They are re-exported here so every existing mail call
// site — and the whole test table below — is unchanged.
pub use crate::services::web_safety::{
    has_userinfo, host_in_text, host_of, hosts_in_text, idna_display, is_format_char, registrable,
    sanitize_attachment_name, scheme_of, SafeName, FORMAT_CHARS, MAX_NAME_BYTES, RESERVED_NAMES,
};

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// CPU time this thread has used — what the complexity tests bound. Wall
    /// time is not theirs to bound: in a 24-thread `cargo test` the sanitize
    /// of the link-heavy body spent 0.8 s on-CPU across 6 s of wall clock.
    #[cfg(unix)]
    fn thread_cpu_time() -> Duration {
        let mut now = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // SAFETY: `now` is a valid, writable timespec for the call's duration.
        let rc = unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut now) };
        assert_eq!(rc, 0, "clock_gettime(CLOCK_THREAD_CPUTIME_ID)");
        Duration::new(now.tv_sec as u64, now.tv_nsec as u32)
    }

    /// Wall clock where no per-thread CPU clock is wired up (Windows CI runs
    /// few enough test threads for it to hold).
    #[cfg(not(unix))]
    fn thread_cpu_time() -> Duration {
        static ORIGIN: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
        ORIGIN.get_or_init(std::time::Instant::now).elapsed()
    }

    /// Applied to **every** sanitizer fixture's output, not only the case it
    /// was written for. A payload that slips past its own assertion but trips
    /// one of these is still caught.
    const FORBIDDEN_IN_ANY_OUTPUT: &[&str] = &[
        "<script",
        "</script",
        "javascript:",
        "onerror",
        "onload",
        "onclick",
        "onfocus",
        "onmouseover",
        "href=",
        "src=http",
        "src='http",
        "src=\"http",
        "srcset",
        "<style",
        "<iframe",
        "<object",
        "<embed",
        "<form",
        "<input",
        "<base",
        "<meta",
        "<link",
        "<svg",
        "<math",
        "<template",
        "<noscript",
        "<audio",
        "<video",
        "<source",
        "background=",
        "@import",
        "expression(",
        "url(",
        "vbscript:",
        "data:text/html",
        "<!--",
    ];

    fn clean(input: &str) -> String {
        sanitize_message_html(input).expect("sanitize").html
    }

    fn assert_blanket(name: &str, out: &str) {
        let lower = out.to_ascii_lowercase();
        for bad in FORBIDDEN_IN_ANY_OUTPUT {
            assert!(
                !lower.contains(bad),
                "case `{name}`: output must not contain `{bad}`\n---\n{out}\n---"
            );
        }
    }

    #[test]
    fn sanitizer_fixtures() {
        // (name, input, extra substrings that must not survive)
        let cases: &[(&str, &str, &[&str])] = &[
            ("script-tag", "<script>alert(1)</script>", &["alert(1)"]),
            ("img-onerror", "<img src=x onerror=alert(1)>", &["alert(1)"]),
            (
                "javascript-href",
                "<a href=\"javascript:alert(1)\">click</a>",
                &["alert(1)"],
            ),
            (
                "entity-scheme",
                "<a href=\"&#106;avascript:alert(1)\">x</a>",
                &["alert(1)"],
            ),
            (
                "newline-entity-scheme",
                "<a href=\"  &#x0A;javascript:alert(1)\">x</a>",
                &["alert(1)"],
            ),
            (
                "tab-in-scheme",
                "<a href=\"jav&#x09;ascript:alert(1)\">x</a>",
                &["alert(1)"],
            ),
            (
                "svg-namespace-confusion",
                "<svg><script>alert(1)</script></svg>",
                &["alert(1)"],
            ),
            (
                "mxss-math-mglyph",
                "<math><mtext><table><mglyph><style><!--</style><img src onerror=alert(1)>",
                &["alert(1)"],
            ),
            (
                "mxss-noscript",
                "<noscript><p title=\"</noscript><img src=x onerror=alert(1)>\">",
                &["alert(1)"],
            ),
            (
                "style-import",
                "<style>@import url(https://evil.example/x.css)</style>",
                &["evil.example"],
            ),
            (
                "style-background-url",
                "<div style=\"background:url(https://evil.example/pixel.gif)\">x</div>",
                &["evil.example"],
            ),
            (
                "style-position-overlay",
                "<div style=\"position:fixed;top:0;left:0;width:100%;height:100%;z-index:9999\">x</div>",
                &["position", "z-index", "fixed"],
            ),
            ("base-tag", "<base href=\"https://evil.example/\">", &["evil.example"]),
            (
                "meta-refresh",
                "<meta http-equiv=\"refresh\" content=\"0;url=https://evil.example\">",
                &["evil.example"],
            ),
            (
                "form-password",
                "<form action=\"https://evil.example\"><input name=p type=password></form>",
                &["evil.example"],
            ),
            (
                "iframe-object-embed",
                "<iframe src=\"https://evil.example\"></iframe><object data=\"https://evil.example\"></object><embed src=\"https://evil.example\">",
                &["evil.example"],
            ),
            (
                "img-srcset",
                "<img srcset=\"https://evil.example/a 1x, https://evil.example/b 2x\">",
                &["evil.example"],
            ),
            (
                "body-background",
                "<body background=\"https://evil.example/p.gif\">x</body>",
                &["evil.example"],
            ),
            (
                "link-stylesheet",
                "<link rel=stylesheet href=\"https://evil.example/s.css\">",
                &["evil.example"],
            ),
            (
                "input-image",
                "<input type=image src=\"https://evil.example/p.gif\">",
                &["evil.example"],
            ),
            (
                "video-poster",
                "<video poster=\"https://evil.example/p.gif\"><source src=\"https://evil.example/v\"></video>",
                &["evil.example"],
            ),
            (
                "anchor-extra-attributes",
                "<a href=\"https://ok.example\" target=\"_top\" rel=\"opener\" download=\"x.exe\">t</a>",
                &["target", "download", "_top", "opener"],
            ),
            ("nul-in-tag-name", "<scr\0ipt>alert(1)</scr\0ipt>", &[]),
            // `<![CDATA[` is a *bogus comment* in HTML content, so html5ever
            // eats `<![CDATA[<script>` as a comment and what follows becomes
            // ordinary text. `alert(1)` therefore survives as visible text —
            // which is inert, and the blanket rule (no `<script`) is the
            // assertion that matters. Asserting the text is gone would be
            // asserting the wrong thing.
            ("cdata", "<![CDATA[<script>alert(1)</script>]]>", &[]),
            (
                "template-script",
                "<template><script>alert(1)</script></template>",
                &["alert(1)"],
            ),
        ];

        for (name, input, must_not) in cases {
            let out = clean(input);
            assert_blanket(name, &out);
            let lower = out.to_ascii_lowercase();
            for bad in *must_not {
                assert!(
                    !lower.contains(&bad.to_ascii_lowercase()),
                    "case `{name}`: output must not contain `{bad}`\n---\n{out}\n---"
                );
            }
            // Stability: re-sanitizing must reach a fixed point and must never
            // *gain* anything. Note the fixed point is reached at the second
            // pass, not the first, and only for anchors: `data-lid` is minted
            // by this module and is deliberately not in any input allowlist, so
            // feeding our own output back strips it. Everything else is
            // idempotent at pass one. The property that matters — markup that
            // mutates into something new on re-parse (mXSS) — is what the
            // second-pass equality catches.
            let once = clean(&out);
            let twice = clean(&once);
            assert_eq!(once, twice, "case `{name}` does not reach a fixed point");
            assert_blanket(name, &once);
        }
    }

    /// The positive control. A filter that strips everything passes every
    /// negative test and is useless, so at least one case asserts survival.
    #[test]
    fn a_realistic_body_survives_sanitization() {
        let input = r#"
            <div style="color:#333;font-family:Helvetica">
              <h1>Weekly digest</h1>
              <table border="0"><tr><td colspan="2" style="width:100px;color:red">Cell</td></tr></table>
              <p>Hello <strong>there</strong> — read <a href="https://news.example/story">the story</a>.</p>
              <ul><li>one</li><li>two</li></ul>
            </div>"#;
        let out = sanitize_message_html(input).unwrap();
        assert_blanket("newsletter", &out.html);
        for expected in [
            "Weekly digest",
            "<table",
            "<td",
            "colspan=\"2\"",
            "<strong>there</strong>",
            "<li>one</li>",
            "the story",
            "color:#333",
            "width:100px",
        ] {
            assert!(
                out.html.contains(expected),
                "over-stripped: expected `{expected}` in\n{}",
                out.html
            );
        }
        assert_eq!(out.links.len(), 1);
        assert_eq!(out.links[0].href, "https://news.example/story");
        assert!(out.html.contains("data-lid=\"0\""));
    }

    /// Case 13 of plan B §7.1: the style filter must not be a blanket strip.
    #[test]
    fn benign_style_declarations_survive() {
        let out = clean("<div style=\"width:100px;color:red\">x</div>");
        assert!(out.contains("width:100px"), "{out}");
        assert!(out.contains("color:red"), "{out}");
    }

    #[test]
    fn display_values_outside_the_allowlist_are_dropped() {
        let out = clean("<div style=\"display:-webkit-box;color:red\">x</div>");
        assert!(!out.contains("webkit"), "{out}");
        assert!(out.contains("color:red"), "{out}");
        let ok = clean("<div style=\"display:block\">x</div>");
        assert!(ok.contains("display:block"), "{ok}");
    }

    /// html5ever's tree builder is iterative; this proves it and guards against
    /// a future recursive post-pass being added above it.
    /// html5ever's tree builder is iterative, so this cannot overflow — but
    /// ammonia's clean is quadratic in nesting depth, so without the input
    /// bound it takes minutes. Both properties are asserted: it returns, and it
    /// returns *quickly*.
    #[test]
    fn a_hundred_thousand_unclosed_divs_returns_quickly_without_overflowing() {
        let input = "<div>".repeat(100_000);
        let started = thread_cpu_time();
        let out = sanitize_within(&input, Duration::MAX).expect("must return, not overflow");
        let spent = thread_cpu_time() - started;
        assert!(out.truncated, "the nesting cap must have fired");
        assert!(
            spent < MAX_SANITIZE,
            "took {spent:?} of CPU, which is what the input caps exist to prevent"
        );
        assert!(count_elements(&out.html) <= MAX_ELEMENTS + 1);
    }

    /// A flat body over the element budget is cut too, and the cut is reported.
    #[test]
    fn a_body_over_the_element_budget_is_truncated_and_says_so() {
        let input = "<p>x</p>".repeat(MAX_ELEMENTS);
        // Truncation, not speed, is under test: no wall-clock budget.
        let out = sanitize_within(&input, Duration::MAX).unwrap();
        assert!(out.truncated);
        assert!(count_elements(&out.html) <= MAX_ELEMENTS + 1);
    }

    /// The link table used to be built with a `contains` + `find` **per link**
    /// over the whole fragment, i.e. O(links × bytes). Both caps are high enough
    /// for that to be a hang rather than a slowdown: the body below (19 000
    /// anchors, 4.5 MB — comfortably inside `MAX_ELEMENTS` and `MAX_HTML_BYTES`,
    /// so nothing refuses it early) took **9.4 s in a release build** and came
    /// back `Err(Timeout)`, because `MAX_SANITIZE` is only checked after the
    /// fact. A timed-out body is never cached either, so every re-open paid it
    /// again: a repeatable multi-second CPU burn per click, from one message.
    #[test]
    fn a_body_full_of_links_does_not_take_quadratic_time() {
        let pad = "x".repeat(200);
        let mut input = String::with_capacity(5 * 1024 * 1024);
        for i in 0..19_000 {
            input.push_str(&format!("<a href=\"https://e{i}.example/p\">t</a>{pad}"));
        }
        assert!(
            input.len() < MAX_HTML_BYTES,
            "the fixture must not be refused early"
        );

        let started = thread_cpu_time();
        let out = sanitize_within(&input, Duration::MAX).expect("must not time out");
        let elapsed = thread_cpu_time() - started;

        assert!(
            elapsed < MAX_SANITIZE,
            "took {elapsed:?} — the link table is quadratic again"
        );
        // And it is still correct: every row resolves to its own anchor, and
        // every surviving marker got a row. (Checked against the one-pass index
        // rather than with a `contains` per link — that spelling is the very
        // thing under test, and it made this test itself take a minute.)
        assert!(!out.links.is_empty());
        let positions = lid_positions(&out.html);
        assert_eq!(positions.len(), out.links.len(), "a marker lost its row");
        for link in &out.links {
            assert!(positions.contains_key(&link.lid), "lid {} lost", link.lid);
            assert_eq!(link.display_host, format!("e{}.example", link.lid));
            assert_eq!(link.href, format!("https://e{}.example/p", link.lid));
        }
    }

    #[test]
    fn a_normal_body_is_not_reported_as_truncated() {
        let out = sanitize_message_html("<p>hello</p>").unwrap();
        assert!(!out.truncated);
    }

    #[test]
    fn an_oversized_body_is_refused_with_a_typed_error() {
        let big = "a".repeat(MAX_HTML_BYTES + 1);
        assert!(matches!(
            sanitize_message_html(&big),
            Err(SanitizeError::TooLarge { .. })
        ));
    }

    #[test]
    fn every_href_is_replaced_by_a_data_lid() {
        let out = sanitize_message_html(
            "<a href=\"https://a.example/1\">one</a><a href=\"https://b.example/2\">two</a>",
        )
        .unwrap();
        assert!(!out.html.contains("href"), "{}", out.html);
        assert!(out.html.contains("data-lid=\"0\""));
        assert!(out.html.contains("data-lid=\"1\""));
        assert_eq!(out.links.len(), 2);
        assert_eq!(out.links[1].href, "https://b.example/2");
    }

    #[test]
    fn a_link_whose_text_names_another_host_is_flagged() {
        let out =
            sanitize_message_html("<a href=\"https://evil.example/login\">www.bank.example</a>")
                .unwrap();
        assert!(out.links[0].mismatch, "{:?}", out.links[0]);
        assert_eq!(out.links[0].display_host, "evil.example");
    }

    #[test]
    fn the_same_registrable_domain_is_not_a_mismatch() {
        let out =
            sanitize_message_html("<a href=\"https://bank.example/y\">https://bank.example/x</a>")
                .unwrap();
        assert!(!out.links[0].mismatch, "{:?}", out.links[0]);
    }

    #[test]
    fn a_backslash_link_is_labelled_with_the_host_a_browser_visits() {
        // A browser reads `\\` as `/`: this goes to evil.example, path
        // `/@bank.example/login`, and that is the host the user is shown.
        let link = link_info(0, "https://evil.example\\@bank.example/login", "Your bank");
        assert_eq!(link.display_host, "evil.example");
        // …and the text claiming the other site still flags it.
        assert!(link_info(0, "https://evil.example\\@bank.example/login", "bank.example").mismatch);
    }

    #[test]
    fn any_host_the_link_text_names_counts_not_only_the_first_word() {
        assert!(link_info(0, "https://evil.example/", "Sign in to paypal.com").mismatch);
        assert!(!link_info(0, "https://www.paypal.com/", "Sign in to paypal.com").mismatch);
        // Ordinary prose with dots in it is not a claimed site.
        assert!(!link_info(0, "https://shop.example/", "Download report.pdf, e.g. 3.14").mismatch);
    }

    #[test]
    fn an_internationalized_host_is_shown_in_both_forms() {
        let link = link_info(0, "https://xn--pypal-4ve.com/", "pay");
        assert!(link.display_host.contains("xn--pypal-4ve.com"), "{}", link.display_host);
        assert_ne!(link.display_host, "xn--pypal-4ve.com");
    }

    #[test]
    fn a_data_lid_spelled_out_in_text_is_not_a_link_marker() {
        let html = r#"<p>data-lid="0" decoy</p><a style="x" data-lid="0">real text</a>"#;
        let at = lid_positions(html)[&0];
        assert_eq!(anchor_text_at(html, at), "real text");
    }

    #[test]
    fn userinfo_in_the_url_is_always_a_mismatch() {
        let out =
            sanitize_message_html("<a href=\"https://bank.example@evil.example/login\">go</a>")
                .unwrap();
        assert!(out.links[0].mismatch);
        assert_eq!(out.links[0].display_host, "evil.example");
    }

    #[test]
    fn a_non_web_scheme_carries_a_warning() {
        let out = sanitize_message_html("<a href=\"ftp://files.example/x\">f</a>").unwrap();
        assert_eq!(out.links[0].scheme_warning.as_deref(), Some("ftp"));
        let ok = sanitize_message_html("<a href=\"https://ok.example/\">o</a>").unwrap();
        assert!(ok.links[0].scheme_warning.is_none());
        let mail = sanitize_message_html("<a href=\"mailto:a@example.com\">m</a>").unwrap();
        assert!(mail.links[0].scheme_warning.is_none());
    }

    /// `javascript:`/`data:`/`file:` anchors lose the attribute before our
    /// filter ever sees them, so they get no table row and therefore no
    /// clickable affordance at all.
    #[test]
    fn a_dangerous_scheme_never_reaches_the_link_table() {
        for url in [
            "javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "file:///etc/passwd",
            "vbscript:msgbox(1)",
        ] {
            let out = sanitize_message_html(&format!("<a href=\"{url}\">x</a>")).unwrap();
            assert!(out.links.is_empty(), "{url} produced {:?}", out.links);
            assert!(!out.html.contains("data-lid"), "{url}: {}", out.html);
        }
    }

    /// html5ever serializes attributes in **source** order, so a real-world
    /// `<a style="…" href="…">` puts `href` second. The rename must still fire:
    /// a surviving `href=` trips the frontend's `bodyLooksUnsafe` tripwire and
    /// the WHOLE message renders as the "unsafe body" error card, while the link
    /// itself gets no `data-lid` and disappears from the link panel.
    #[test]
    fn an_href_that_is_not_the_first_attribute_is_still_renamed() {
        for input in [
            "<a style=\"color:red\" href=\"https://ok.example/1\">t</a>",
            "<a dir=\"ltr\" href=\"https://ok.example/1\">t</a>",
            "<a href=\"https://ok.example/1\" style=\"color:red\">t</a>",
        ] {
            let out = sanitize_message_html(input).unwrap();
            assert!(!out.html.contains("href"), "{input} → {}", out.html);
            assert!(
                out.html.contains("data-lid=\"0\""),
                "{input} → {}",
                out.html
            );
            // Without the class the frame's `.mail-link` rule matches nothing
            // and a link renders as indistinguishable plain text.
            assert!(
                out.html.contains("class=\"mail-link\""),
                "{input} → {}",
                out.html
            );
            assert_eq!(out.links.len(), 1, "{input} → {:?}", out.links);
        }
    }

    /// The mismatch check reads the anchor's display text out of the serialized
    /// output. An anchor with a second attribute must not silently yield an
    /// empty text — that would turn phishing detection off for every styled
    /// link, which is nearly all of them in real HTML mail.
    #[test]
    fn a_styled_anchor_is_still_checked_for_a_host_mismatch() {
        for input in [
            "<a href=\"https://evil.example/login\" style=\"color:#06c\">www.bank.example</a>",
            "<a style=\"color:#06c\" href=\"https://evil.example/login\">www.bank.example</a>",
            "<a href=\"https://evil.example/login\" dir=\"ltr\">www.bank.example</a>",
        ] {
            let out = sanitize_message_html(input).unwrap();
            assert_eq!(out.links.len(), 1, "{input}");
            assert!(out.links[0].mismatch, "{input} → {:?}", out.links[0]);
        }
    }

    #[test]
    fn remote_references_are_counted_for_the_banner() {
        let out = sanitize_message_html(
            "<img src=\"https://tracker.example/1.gif\"><img src='http://tracker.example/2.gif'>",
        )
        .unwrap();
        assert_eq!(out.remote_refs, 2);
        assert!(!out.html.contains("tracker.example"));
    }

    #[test]
    fn plain_text_is_escaped_not_parsed() {
        let out = plain_text_to_html("<script>alert(1)</script> & <b>x</b>");
        assert!(!out.contains("<script"));
        assert!(out.contains("&lt;script&gt;"));
        assert!(out.contains("&amp;"));
    }

    // ── sanitize_attachment_name ────────────────────────────────────────────

    #[test]
    fn attachment_name_table() {
        let cases: &[(&str, &str)] = &[
            ("report.pdf", "report.pdf"),
            ("../../etc/passwd", "passwd"),
            ("..\\..\\Windows\\System32\\evil.exe", "evil.exe"),
            ("/absolute/path/x.txt", "x.txt"),
            ("C:\\Users\\x\\y.txt", "y.txt"),
            ("file.txt:hidden", "file.txt"),
            ("CON", "_CON"),
            ("con.txt", "_con.txt"),
            ("COM1.log", "_COM1.log"),
            ("AUX ", "_AUX"),
            (".bashrc", "_.bashrc"),
            ("-rf", "_-rf"),
            ("--force.txt", "_--force.txt"),
            ("a\u{0000}b.txt", "ab.txt"),
            ("x\u{007F}\u{0009}y.txt", "xy.txt"),
            ("\"quoted\"<>|?*.txt", "_quoted______.txt"),
            ("trailing...", "trailing"),
            ("trailing.  ", "trailing"),
            ("", "attachment"),
            (".", "attachment"),
            ("..", "attachment"),
            ("   ", "attachment"),
        ];
        for (input, expected) in cases {
            let got = sanitize_attachment_name(input);
            assert_eq!(
                got.value, *expected,
                "input {input:?} → {:?}, expected {expected:?}",
                got.value
            );
        }
    }

    #[test]
    fn an_unchanged_name_reports_changed_false() {
        let got = sanitize_attachment_name("report.pdf");
        assert!(!got.changed);
        assert!(got.reason.is_none());
    }

    /// `invoice\u{202E}gnp.exe` renders as `invoicexe.png`. The override must
    /// not survive, and the result must still end in the real extension.
    #[test]
    fn the_rtl_override_disguise_is_defused() {
        let got = sanitize_attachment_name("invoice\u{202E}gnp.exe");
        assert!(!got.value.contains('\u{202E}'));
        assert!(!got.value.ends_with(".png"), "{}", got.value);
        assert!(got.value.ends_with(".exe"), "{}", got.value);
        assert!(got.changed);
    }

    #[test]
    fn a_name_of_only_bidi_controls_becomes_attachment() {
        let got = sanitize_attachment_name("\u{200E}\u{200F}\u{202A}\u{2066}");
        assert_eq!(got.value, "attachment");
    }

    #[test]
    fn long_names_are_truncated_on_a_char_boundary_keeping_the_extension() {
        let ascii = format!("{}.pdf", "a".repeat(500));
        let got = sanitize_attachment_name(&ascii);
        assert!(got.value.len() <= MAX_NAME_BYTES, "{}", got.value.len());
        assert!(got.value.ends_with(".pdf"));

        let wide = format!("{}.pdf", "é".repeat(300));
        let got = sanitize_attachment_name(&wide);
        assert!(got.value.len() <= MAX_NAME_BYTES, "{}", got.value.len());
        assert!(got.value.ends_with(".pdf"));
        // Valid UTF-8 by construction in Rust, but assert the boundary logic
        // did not leave a replacement char behind.
        assert!(!got.value.contains('\u{FFFD}'));
    }

    /// Property test: whatever bytes a sender sends, the output is always
    /// non-empty, separator-free, control-free, bounded, and not a device name.
    #[test]
    fn sanitize_attachment_name_is_total() {
        let mut seed: u64 = 0x5EED_1234_ABCD_0001;
        for _ in 0..10_000 {
            let mut bytes = Vec::new();
            let len = {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                (seed >> 33) as usize % 64
            };
            for _ in 0..len {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                bytes.push((seed >> 24) as u8);
            }
            let input = String::from_utf8_lossy(&bytes);
            let got = sanitize_attachment_name(&input);
            assert!(!got.value.is_empty());
            assert!(!got.value.contains('/'), "{:?}", got.value);
            assert!(!got.value.contains('\\'), "{:?}", got.value);
            assert!(!got.value.chars().any(|c| c.is_control()));
            assert!(!got.value.chars().any(is_format_char));
            assert!(got.value.len() <= MAX_NAME_BYTES);
            let stem = got.value.split('.').next().unwrap_or("");
            assert!(
                !RESERVED_NAMES.iter().any(|r| r.eq_ignore_ascii_case(stem)),
                "{:?} is a reserved device name",
                got.value
            );
        }
    }

    /// A change to the allowlists without a `SANITIZER_VERSION` bump would keep
    /// serving bodies cleaned by the old rules out of `bodies_cache`.
    #[test]
    fn sanitizer_version_matches_the_builder_configuration() {
        // A cheap structural fingerprint: if you changed any list below, bump
        // SANITIZER_VERSION and update this number.
        let fingerprint = ALLOWED_TAGS.len()
            + CLEAN_CONTENT_TAGS.len() * 100
            + ALLOWED_STYLE_PROPERTIES.len() * 10_000
            + BANNED_ATTRIBUTES.len() * 1_000_000;
        assert_eq!(
            fingerprint, 14_431_054,
            "you changed the sanitizer's configuration; bump SANITIZER_VERSION \
             (so cached bodies are re-sanitized) and update this fingerprint"
        );
        // Bumped to 2 for the two `mail_engine` body-pipeline fixes (UTF-7
        // label coverage, `text/plain` never offered as HTML) — the cache
        // stores their output, so without a bump a body parsed under the old
        // rules would keep being served. Bumped to 3 for the link table
        // (browser-parsed hosts, every host in the text, both IDN forms,
        // `data-lid` only inside tags) and crypto-bearing bodies leaving the
        // cache.
        assert_eq!(SANITIZER_VERSION, 3);
    }
}

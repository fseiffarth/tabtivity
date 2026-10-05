//! One hostile message, driven through the **whole** inbound pipeline.
//!
//! The unit tests in `mail_sanitize` and `mail_engine` each check one payload
//! against the layer it targets. This checks the thing a user actually meets:
//! a single realistic phishing mail carrying ~40 payloads at once — script
//! elements, mutation-XSS constructs, framing, a credential form, a
//! full-viewport fake-Tabtivity overlay, trackers in every fetching attribute,
//! every way a URL can lie about its destination, and four attachments whose
//! names attack the filesystem — parsed by `parse_message` and cleaned by
//! `sanitize_message_html` exactly as `commands::mail` does it.
//!
//! Fixture: `tests/fixtures/mail/hostile_kitchen_sink.eml` (generated, not
//! hand-typed: the HTML part is base64 so a raw NUL, the RTL override and an
//! unterminated `<!--` survive into the parser byte-for-byte).
//!
//! The sanitized fragment is also checked into `src/__tests__/fixtures/` and
//! asserted here to be byte-identical, so the frontend's tripwire test
//! (`MailHostileBody.test.ts`) is judging **this** pipeline's real output and
//! cannot silently drift from it.

use app_lib::schema::mail::{MailAuthState, MailAuthVerdict};
use app_lib::services::mail_authres::{apply_trust, parse_authentication_results};
use app_lib::services::mail_engine::parse_message;
use app_lib::services::mail_sanitize::sanitize_message_html;

fn fixture() -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/mail/hostile_kitchen_sink.eml");
    std::fs::read(&path).unwrap_or_else(|e| panic!("hostile fixture: {e}"))
}

/// Markup that must not appear in the sanitized body at all, whatever payload
/// put it there. Deliberately broader than the union of the per-case
/// assertions: a payload that slips past the check written for it still has to
/// get past this.
///
/// Note what is **not** here: `alert(`. A `<![CDATA[<script>alert(1)</script>]]>`
/// is a bogus comment in HTML content, so what survives is the *text*
/// `alert(1)]]>` — inert, and asserting it were gone would be asserting the
/// wrong thing (the same reasoning as the `cdata` case in `mail_sanitize`'s own
/// fixtures). Text is not evidence; markup is.
const FORBIDDEN_MARKUP: &[&str] = &[
    // active elements
    "<script",
    "</script",
    "<style",
    "<iframe",
    "<object",
    "<embed",
    "<form",
    "<input",
    "<button",
    "<base",
    "<meta",
    "<link",
    "<svg",
    "<math",
    "<template",
    "<noscript",
    "<textarea",
    "<xmp",
    "<audio",
    "<video",
    "<source",
    "<body",
    "<html",
    "<head",
    // comments and bogus comments re-parse differently in the renderer
    "<!--",
    "<![",
];

/// Substrings that must not appear **inside a start tag** — i.e. in attribute
/// position, where they would mean something. Checked tag-scoped rather than
/// over the whole string because every one of them is legitimate as body text
/// in a mail *about* HTML, which this being a developer tool makes the normal
/// case rather than the exotic one.
const FORBIDDEN_IN_TAGS: &[&str] = &[
    // handlers and script schemes
    "onerror",
    "onload",
    "onclick",
    "onfocus",
    "onmouseover",
    "javascript:",
    "vbscript:",
    "data:text/html",
    // anything that navigates or fetches
    "href=",
    "src=",
    "srcset",
    "formaction",
    "action=",
    "background=",
    "poster=",
    "ping=",
    "download=",
    "target=",
    "xlink",
    "@import",
    "url(",
    "expression(",
    // fake-chrome CSS
    "position:",
    "z-index",
    "opacity",
    "filter:",
    "transform:",
    "pointer-events",
    "webkit",
    // no attribute may name a host the payloads point at
    "evil.example",
    "tracker.example",
];

/// The start tags of a serialized fragment, lowercased, without their contents.
fn start_tags(html: &str) -> Vec<String> {
    let lower = html.to_ascii_lowercase();
    let mut out = Vec::new();
    let mut rest = lower.as_str();
    while let Some(open) = rest.find('<') {
        rest = &rest[open..];
        let end = rest.find('>').map(|e| e + 1).unwrap_or(rest.len());
        out.push(rest[..end].to_string());
        rest = &rest[end..];
    }
    out
}

#[test]
fn the_hostile_message_renders_inert() {
    let parsed = parse_message(&fixture()).expect("the message must parse, not be refused");

    // ── The body reached the HTML path at all (a test that silently fell back
    //    to plain text would assert nothing about the sanitizer). ───────────
    let html = parsed
        .html
        .as_deref()
        .expect("the text/html part must be used");
    assert!(
        html.contains("<script>alert('script-element')</script>"),
        "the fixture must reach the sanitizer still hostile"
    );

    let out = sanitize_message_html(html).expect("a hostile body must be cleaned, not refused");
    let lower = out.html.to_ascii_lowercase();

    for bad in FORBIDDEN_MARKUP {
        assert!(
            !lower.contains(bad),
            "sanitized body still contains `{bad}`\n---\n{}\n---",
            out.html
        );
    }

    for tag in start_tags(&out.html) {
        for bad in FORBIDDEN_IN_TAGS {
            assert!(
                !tag.contains(bad),
                "`{bad}` survived in a start tag: `{tag}`"
            );
        }
        // And no event handler at all, by shape rather than by name — the `on*`
        // list grows with every spec revision.
        assert!(
            !tag.split_whitespace()
                .any(|w| w.starts_with("on") && w.contains('=')),
            "an event handler survived in `{tag}`"
        );
    }

    // ── Positive control: the message is still *readable*. A sanitizer that
    //    strips everything passes every assertion above and is useless. ─────
    for kept in [
        "Your account needs attention",
        "Security Team",
        "<table",
        "<strong>",
    ] {
        assert!(out.html.contains(kept), "over-stripped: `{kept}` is gone");
    }

    // ── The links table: dangerous schemes get no row at all, so the UI has no
    //    affordance to offer for them. ──────────────────────────────────────
    for scheme in ["javascript:", "vbscript:", "data:", "file:"] {
        assert!(
            !out.links
                .iter()
                .any(|l| l.href.to_ascii_lowercase().starts_with(scheme)),
            "a `{scheme}` link reached the link table: {:?}",
            out.links
        );
    }

    // The display-text-vs-href phishing anchors are flagged.
    let phish = out
        .links
        .iter()
        .find(|l| l.href == "https://evil.example/login")
        .expect("the phishing anchor must be in the table");
    assert!(
        phish.mismatch,
        "text says bank.example, href says evil.example"
    );
    assert_eq!(phish.display_host, "evil.example");

    let userinfo = out
        .links
        .iter()
        .find(|l| l.href.contains("bank.example@evil.example"))
        .expect("the userinfo anchor must be in the table");
    assert!(
        userinfo.mismatch,
        "userinfo must always count as a mismatch"
    );
    assert_eq!(
        userinfo.display_host, "evil.example",
        "the host is the part after the last @, and the panel must say so"
    );

    // The IDN homograph: `xn--bnk-qla.example` is `bänk.example`, and the anchor
    // claims to be `bank.example`. It must come back flagged.
    //
    // Worth knowing about the row itself: `display_host` is the **Unicode** form
    // (`bänk.example`), so the row alone does not disclose that the host is an
    // IDN — the punycode is visible only in the confirm dialog's full-URL line.
    // The in-app browser's address bar does show both forms side by side; the
    // mail link row does not. The mismatch flag is what carries the warning here.
    let idn = out
        .links
        .iter()
        .find(|l| l.href.contains("xn--"))
        .expect("the IDN anchor must be in the table");
    assert!(idn.mismatch, "an IDN homograph must be flagged: {idn:?}");
    assert!(
        idn.href.contains("xn--"),
        "the confirm dialog's full URL must keep the punycode: {idn:?}"
    );

    // Non-web schemes carry a warning, so the UI offers no Open button.
    let ftp = out
        .links
        .iter()
        .find(|l| l.href.starts_with("ftp://"))
        .unwrap();
    assert_eq!(ftp.scheme_warning.as_deref(), Some("ftp"));

    // No link row carries a bidi control that could reorder what it says.
    for link in &out.links {
        assert!(
            !link
                .display_host
                .chars()
                .any(|c| ('\u{202A}'..='\u{202E}').contains(&c)),
            "a bidi control survived into a link row: {link:?}"
        );
    }

    // ── Remote content was seen, counted, and dropped. ─────────────────────
    assert!(
        out.remote_refs >= 4,
        "the trackers must be counted for the banner, got {}",
        out.remote_refs
    );

    // ── Re-sanitizing reaches a fixed point: nothing here mutates into new
    //    markup on a second parse, which is the mXSS property. ─────────────
    let once = sanitize_message_html(&out.html).unwrap();
    let twice = sanitize_message_html(&once.html).unwrap();
    assert_eq!(
        once.html, twice.html,
        "the body does not reach a fixed point"
    );
}

/// **A known behaviour, characterized rather than asserted as desirable.**
///
/// An *unclosed* MathML/SVG **text integration point** — `<math><mtext>`,
/// `<svg><desc>`, `<svg><title>`, `<svg><foreignObject>` — makes every following
/// sibling a *child* of a foreign element, because HTML parsing resumes inside
/// one. Ammonia then drops the foreign element together with its whole subtree,
/// so the rest of the message disappears.
///
/// It fails **closed** — nothing executes, which is the property that matters
/// and is asserted here. But the loss is currently *silent*: `truncated` stays
/// false, so the pane renders an empty frame with no explanation, and a message
/// can make its own body vanish. A closed integration point (`<svg><title>Logo
/// </title>` — the ordinary accessible-name idiom in a newsletter) is fine, so
/// this needs a crafted message rather than a careless one.
///
/// If a later change makes the drop visible (a `truncated`-style flag) or keeps
/// the children, this test is the place that says what changed and why.
#[test]
fn an_unclosed_foreign_integration_point_eats_the_body_but_stays_inert() {
    for payload in [
        "<math><mtext>",
        "<svg><desc>",
        "<svg><title>",
        "<svg><foreignObject>",
    ] {
        let body = format!(
            "<p>Visible before</p>{payload}<img src=x onerror=alert(1)><p>Visible after</p>"
        );
        let out = sanitize_message_html(&body).unwrap();
        let lower = out.html.to_ascii_lowercase();

        // The property that matters: inert.
        assert!(!lower.contains("onerror"), "{payload}: {}", out.html);
        assert!(!lower.contains("<script"), "{payload}: {}", out.html);
        assert!(!lower.contains("alert("), "{payload}: {}", out.html);

        // The property that is merely *true today*: everything from the payload
        // on is gone, and nothing says so.
        assert!(
            !out.html.contains("Visible after"),
            "{payload} no longer swallows what follows — good; update this test"
        );
        assert!(
            !out.truncated,
            "{payload} now reports the loss — good; update this test"
        );
    }

    // The ordinary, closed spelling a real newsletter uses is unaffected.
    let ok = sanitize_message_html(
        "<svg><title>Logo</title><rect/></svg><h1>Newsletter</h1><p>body copy</p>",
    )
    .unwrap();
    assert!(ok.html.contains("Newsletter"), "{}", ok.html);
    assert!(ok.html.contains("body copy"), "{}", ok.html);
}

#[test]
fn the_hostile_attachments_cannot_attack_the_filesystem() {
    let parsed = parse_message(&fixture()).unwrap();
    let names: Vec<&str> = parsed
        .attachments
        .iter()
        .map(|a| a.meta.filename.as_str())
        .collect();

    for name in &names {
        assert!(!name.contains('/'), "a separator survived in {name:?}");
        assert!(!name.contains('\\'), "a separator survived in {name:?}");
        assert!(!name.contains(".."), "a traversal survived in {name:?}");
        assert!(
            !name
                .chars()
                .any(|c| c.is_control() || ('\u{202A}'..='\u{202E}').contains(&c)),
            "a control/bidi char survived in {name:?}"
        );
    }

    // `invoice<RLO>gnp.exe` renders as `invoicexe.png`; it must come back
    // saying `.exe`, and it must be flagged because the bytes are a PE while
    // the part claims `image/png`.
    let disguised = parsed
        .attachments
        .iter()
        .find(|a| a.meta.filename.starts_with("invoice"))
        .expect("the disguised attachment must survive as an attachment");
    assert!(
        disguised.meta.filename.ends_with(".exe"),
        "the real extension must be what is shown, got {:?}",
        disguised.meta.filename
    );
    assert!(
        disguised.meta.type_mismatch.is_some(),
        "a PE payload labelled image/png must be flagged"
    );

    assert!(
        names.contains(&".bashrc") || names.contains(&"_.bashrc"),
        "{names:?}"
    );
    assert!(
        names.iter().any(|n| n.eq_ignore_ascii_case("_con.txt")),
        "{names:?}"
    );
}

/// The message forges its own `Authentication-Results`, claiming SPF, DKIM and
/// DMARC all passed for `bank.example`. Every one of those clauses is
/// syntactically perfect and completely worthless, and the whole point of the
/// feature is that none of them can reach the user as a verdict.
#[test]
fn a_forged_authentication_results_header_is_never_believed() {
    let parsed = parse_message(&fixture()).unwrap();
    let mut auth = parsed
        .headers
        .auth
        .clone()
        .expect("the forged header must be seen, not skipped");

    assert_eq!(auth.header_count, 2, "both forged instances are counted");
    assert_eq!(auth.authserv_id.as_deref(), Some("evil.example"));

    // 1. The account has configured its real server: the forgery is named and
    //    every verdict is dropped.
    apply_trust(&mut auth, Some("mx.my-provider.example"));
    assert_eq!(auth.state, MailAuthState::Foreign);
    assert!(
        auth.methods.is_empty(),
        "a forged pass must not survive to the UI: {:?}",
        auth.methods
    );

    // 2. The account has configured nothing: still no verdict. This is the
    //    default state, so it is the one that matters most.
    let mut auth = parsed.headers.auth.clone().unwrap();
    apply_trust(&mut auth, None);
    assert_eq!(auth.state, MailAuthState::Unconfigured);
    assert!(auth.methods.is_empty());

    // 3. And the forged clauses were *parsed* correctly all along — the refusal
    //    is a trust decision, not a parse failure that happens to look like one.
    let parsed_only = parse_authentication_results(
        &["evil.example; dkim=pass header.d=bank.example".to_string()],
        "security@bank.example",
    )
    .unwrap();
    assert_eq!(parsed_only.methods.len(), 1);
    assert_eq!(parsed_only.methods[0].result, MailAuthVerdict::Pass);
}

#[test]
fn the_spoofed_sender_is_disclosed_rather_than_resolved() {
    let parsed = parse_message(&fixture()).unwrap();
    let h = &parsed.headers;

    // The display name claims to be an address at a bank; the addr-spec is what
    // the UI always shows beside it, and it is not that.
    assert_ne!(h.from.address, "security@bank.example");
    assert!(h.from.address.ends_with("@evil.example"), "{:?}", h.from);

    // Two `From:` headers is the classic spoofing setup — it must be reported,
    // not silently resolved to whichever one the parser preferred.
    assert!(
        h.malformed_headers
            .iter()
            .any(|m| m.to_ascii_lowercase().contains("from")),
        "a duplicate From must be surfaced: {:?}",
        h.malformed_headers
    );
}

/// The frontend's copy of the sanitized body is the same bytes this pipeline
/// produces. Without this the vitest tripwire could keep passing against an
/// artifact from an older sanitizer.
///
/// Regenerate with `UPDATE_HOSTILE_FIXTURE=1 cargo test --test mail_hostile_message`.
#[test]
fn the_frontend_fixture_is_this_pipelines_output() {
    let parsed = parse_message(&fixture()).unwrap();
    let out = sanitize_message_html(parsed.html.as_deref().unwrap()).unwrap();

    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../src/__tests__/fixtures/hostile_sanitized_body.html");

    if std::env::var("UPDATE_HOSTILE_FIXTURE").is_ok() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &out.html).unwrap();
        return;
    }

    let on_disk = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "{}: {e} — regenerate with UPDATE_HOSTILE_FIXTURE=1",
            path.display()
        )
    });
    assert_eq!(
        on_disk, out.html,
        "the checked-in frontend fixture is stale; regenerate it with \
         UPDATE_HOSTILE_FIXTURE=1 cargo test --test mail_hostile_message"
    );
}

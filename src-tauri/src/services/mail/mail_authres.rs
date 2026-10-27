//! `Authentication-Results` (RFC 8601): what the **receiving server** concluded
//! about SPF, DKIM and DMARC — and, the part that decides whether any of it may
//! be shown, *which* header instance is allowed to say so.
//!
//! ## Why this is worth having at all
//!
//! Verifying SPF/DKIM/DMARC in the client is not possible for a mail that has
//! already been relayed (SPF is about the connecting IP, which is gone by the
//! time IMAP hands us bytes) and is a large crypto surface for DKIM. The
//! receiving MTA has already done all of it and written the answer into a
//! header. Reading that header is nearly free and is most of the value that
//! PGP/S-MIME would otherwise be needed for — *provided* it is the right header.
//!
//! ## Why the topmost one, and only if it is named
//!
//! `Authentication-Results` is ordinary message text. Anyone can write one; a
//! phisher writes `dmarc=pass` and hopes. Two rules make it meaningful:
//!
//! 1. **Only the topmost instance is read.** Headers are prepended, so the one
//!    at the top was written by the last MTA to touch the message — yours.
//! 2. **Only if its `authserv-id` matches the id configured for the account.**
//!    Rule 1 alone is not enough: it identifies the *position*, not the author.
//!    Without the id check, a message that your server did not stamp at all
//!    would present the sender's own forgery in the top position.
//!
//! With no configured id, [`MailAuthState::Unconfigured`] is returned and the UI
//! shows no verdict — deliberately, because a verdict nobody checked is worse
//! than none: it teaches the user to trust a green tick an attacker can draw.
//!
//! ## The limit this cannot fix, stated plainly
//!
//! If your provider does **not** add the header, and an attacker forges one
//! bearing your provider's `authserv-id`, this will believe it. Nothing a client
//! can do distinguishes those two cases — RFC 8601 §5 puts the duty to strip
//! forged instances on the receiving MTA. This is why the setting's help text
//! says to take the id from a message you know is genuine, and why the trust
//! state is disclosed in the UI rather than folded into a bare tick.
//!
//! ## And why `identifier` is never dropped
//!
//! `dkim=pass header.d=evil.example` is a *real* pass — of a signature by the
//! wrong domain. A verdict without the identity it applies to is the single
//! most common way these headers are misread, so every clause carries its
//! domain and an `aligned` flag comparing it to the visible `From`.

use crate::schema::mail::{MailAuthMethod, MailAuthResults, MailAuthState, MailAuthVerdict};
use crate::services::web_safety::registrable;

/// Longest header value parsed. Beyond this the header is treated as
/// unreadable — which can only ever land in `Foreign`, never in a verdict.
pub const MAX_HEADER_BYTES: usize = 4096;

/// Most `method=result` clauses kept from one header.
pub const MAX_METHODS: usize = 16;

/// Deepest `(comment (nesting))` the comment stripper will follow before giving
/// up on the header. RFC 5322 comments nest; a crafted header need not.
const MAX_COMMENT_DEPTH: usize = 8;

/// Parse the message's `Authentication-Results` headers.
///
/// `values` must be **in document order** — the first element is the topmost
/// header and the only one read. `from_address` is the visible `From` addr-spec,
/// used only to compute per-clause alignment.
///
/// Returns `None` when the message carried no such header. The returned `state`
/// is always [`MailAuthState::Unconfigured`]; the caller applies the account's
/// trusted id with [`apply_trust`], because that decision changes when the
/// setting changes and must therefore not be baked into stored data.
pub fn parse_authentication_results(
    values: &[String],
    from_address: &str,
) -> Option<MailAuthResults> {
    let first = values.first()?;
    let header_count = values.len().min(u32::MAX as usize) as u32;

    // An overlong header is not parsed at all. It still reports its existence,
    // with no id — so it cannot match a configured id and cannot show a verdict.
    if first.len() > MAX_HEADER_BYTES {
        return Some(MailAuthResults {
            state: MailAuthState::Unconfigured,
            authserv_id: None,
            methods: Vec::new(),
            header_count,
        });
    }

    let stripped = strip_comments(first);
    let mut segments = split_top_level(&stripped);
    let authserv_id = segments
        .first()
        .and_then(|s| authserv_id_of(s))
        .filter(|s| !s.is_empty());

    let from_domain = domain_of(from_address);
    let mut methods = Vec::new();
    for seg in segments.drain(..).skip(1) {
        if methods.len() >= MAX_METHODS {
            break;
        }
        if let Some(m) = parse_clause(&seg, &from_domain) {
            methods.push(m);
        }
    }

    Some(MailAuthResults {
        state: MailAuthState::Unconfigured,
        authserv_id,
        methods,
        header_count,
    })
}

/// Decide whether `results` may be believed, against the account's configured
/// `authserv-id`. Kept separate from parsing, and applied on every read, so that
/// setting or clearing the id takes effect on already-synced mail immediately.
///
/// The comparison is ASCII-case-insensitive on a trimmed value because an
/// `authserv-id` is a domain-shaped token, and it is **equality**, never a
/// suffix or substring test: `mx.example.com.evil.test` must not satisfy a
/// configured `example.com`.
pub fn apply_trust(results: &mut MailAuthResults, trusted: Option<&str>) {
    let trusted = trusted.map(str::trim).filter(|t| !t.is_empty());
    results.state = match (trusted, results.authserv_id.as_deref()) {
        (None, _) => MailAuthState::Unconfigured,
        (Some(t), Some(id)) if id.trim().eq_ignore_ascii_case(t) => MailAuthState::Verified,
        (Some(_), _) => MailAuthState::Foreign,
    };
    // Belt: a state that is not `Verified` must not carry verdicts the UI could
    // accidentally render. The UI is written not to, but the data should not
    // depend on that being true forever.
    if results.state != MailAuthState::Verified {
        results.methods.clear();
    }
}

/// Remove RFC 5322 comments, honouring quoted strings and `\` escapes.
///
/// Comments may appear between any two tokens and routinely carry the very
/// characters that would otherwise be parsed as structure — a real header has
/// `dkim=pass (1024-bit key; unprotected) header.d=example.com`, and Gmail
/// writes `spf=pass (google.com: domain of x@y designates 1.2.3.4 as permitted
/// sender)`. That parenthesis contains both a `;` and a `=`, so *not* stripping
/// comments first is not a nicety: it invents a clause boundary out of prose.
///
/// Depth beyond [`MAX_COMMENT_DEPTH`] abandons the rest of the header rather
/// than trying to recover — a truncated parse yields fewer clauses, never a
/// wrong verdict.
fn strip_comments(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut depth = 0usize;
    let mut in_quotes = false;
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                // An escaped character is literal in both quoted strings and
                // comments — including an escaped paren, which would otherwise
                // open or close a comment that is not there.
                let escaped = chars.next();
                if depth == 0 {
                    out.push(c);
                    if let Some(e) = escaped {
                        out.push(e);
                    }
                }
            }
            '"' if depth == 0 => {
                in_quotes = !in_quotes;
                out.push(c);
            }
            '(' if !in_quotes => {
                depth += 1;
                if depth > MAX_COMMENT_DEPTH {
                    break;
                }
                // A comment is folding white space: it separates tokens, so it
                // must not glue the ones on either side of it together.
                out.push(' ');
            }
            ')' if !in_quotes && depth > 0 => depth -= 1,
            _ => {
                if depth == 0 {
                    out.push(c);
                }
            }
        }
    }
    out
}

/// Split on `;` outside quoted strings. Comments are already gone.
fn split_top_level(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                cur.push(c);
                if let Some(e) = chars.next() {
                    cur.push(e);
                }
            }
            '"' => {
                in_quotes = !in_quotes;
                cur.push(c);
            }
            ';' if !in_quotes => {
                out.push(std::mem::take(&mut cur));
            }
            _ => cur.push(c),
        }
    }
    out.push(cur);
    out
}

/// The `authserv-id` is the first token of the first segment. An optional
/// version number may follow it (`example.com 1`), and is not part of the id.
fn authserv_id_of(seg: &str) -> Option<String> {
    let tok = seg.split_whitespace().next()?;
    // A first segment that is already a clause (`spf=pass`) means the header
    // has no authserv-id at all. Reporting the method name as an id would be a
    // value an attacker chooses, so this reports none.
    if tok.contains('=') {
        return None;
    }
    Some(
        tok.trim_matches(|c: char| c == ';' || c.is_whitespace())
            .to_string(),
    )
}

/// One `method[/version] = result [ptype.property=pvalue ...]` clause.
fn parse_clause(seg: &str, from_domain: &str) -> Option<MailAuthMethod> {
    let seg = seg.trim();
    if seg.is_empty() {
        return None;
    }
    let mut parts = seg.split_whitespace();
    let head = parts.next()?;
    let (name, result_tok) = head.split_once('=')?;

    // `none` as a whole segment is RFC 8601's "no authentication was done".
    // It is not a method, so it produces no clause.
    let name = name.trim().trim_start_matches(';').trim();
    // A method may carry a version: `dkim/1=pass`.
    let method = name
        .split('/')
        .next()
        .unwrap_or(name)
        .trim()
        .to_ascii_lowercase();
    if method.is_empty()
        || !method
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return None;
    }

    let result = MailAuthVerdict::from_token(result_tok);

    // Properties. Only the identity-bearing ones matter here, and which one
    // that is depends on the method — DKIM signs a domain (`header.d`), SPF
    // authorizes an envelope sender (`smtp.mailfrom`, or the HELO name when
    // the envelope sender is empty), DMARC evaluates the visible From.
    let wanted: &[&str] = match method.as_str() {
        "dkim" => &["header.d", "header.i"],
        "spf" => &["smtp.mailfrom", "smtp.helo"],
        "dmarc" => &["header.from"],
        _ => &[],
    };
    let mut identifier: Option<String> = None;
    let mut best = usize::MAX;
    for prop in parts {
        let Some((key, value)) = prop.split_once('=') else {
            continue;
        };
        let key = key.trim().to_ascii_lowercase();
        let Some(rank) = wanted.iter().position(|w| *w == key) else {
            continue;
        };
        // Earlier entries in `wanted` win, whatever order they appear in.
        if rank < best {
            let value = value.trim().trim_matches('"').trim();
            if !value.is_empty() {
                identifier = Some(domain_of(value));
                best = rank;
            }
        }
    }

    let aligned = identifier
        .as_deref()
        .filter(|_| !from_domain.is_empty())
        .map(|id| !id.is_empty() && registrable(id) == registrable(from_domain));

    Some(MailAuthMethod {
        method,
        result,
        identifier,
        aligned,
    })
}

/// The domain part of an addr-spec, or the value itself when it is already a
/// bare domain. Lowercased, with a leading `@` (as `header.i` often carries)
/// and any angle brackets removed.
fn domain_of(value: &str) -> String {
    let v = value.trim().trim_matches(|c| c == '<' || c == '>').trim();
    let d = match v.rsplit_once('@') {
        Some((_, domain)) => domain,
        None => v,
    };
    d.trim().trim_end_matches('.').to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(header: &str, from: &str) -> MailAuthResults {
        parse_authentication_results(&[header.to_string()], from).expect("a header was given")
    }

    fn trusted(header: &str, from: &str, id: &str) -> MailAuthResults {
        let mut r = parse(header, from);
        apply_trust(&mut r, Some(id));
        r
    }

    fn method<'a>(r: &'a MailAuthResults, name: &str) -> Option<&'a MailAuthMethod> {
        r.methods.iter().find(|m| m.method == name)
    }

    #[test]
    fn no_header_is_absence_not_failure() {
        assert!(parse_authentication_results(&[], "a@example.com").is_none());
    }

    #[test]
    fn a_realistic_header_parses() {
        let r = trusted(
            "mx.example.net; spf=pass smtp.mailfrom=news.example.com; \
             dkim=pass header.d=news.example.com; dmarc=pass header.from=news.example.com",
            "hello@news.example.com",
            "mx.example.net",
        );
        assert_eq!(r.state, MailAuthState::Verified);
        assert_eq!(r.authserv_id.as_deref(), Some("mx.example.net"));
        assert_eq!(r.methods.len(), 3);
        for name in ["spf", "dkim", "dmarc"] {
            let m = method(&r, name).unwrap_or_else(|| panic!("{name} missing"));
            assert_eq!(m.result, MailAuthVerdict::Pass, "{name}");
            assert_eq!(m.identifier.as_deref(), Some("news.example.com"), "{name}");
            assert_eq!(m.aligned, Some(true), "{name}");
        }
    }

    /// The comment form every large provider actually emits. The parenthesis
    /// contains a `;` and an `=`, so a parser that does not strip comments
    /// first invents a clause boundary out of prose.
    #[test]
    fn comments_are_stripped_before_anything_is_split() {
        let r = trusted(
            "mx.example.net; spf=pass (example.net: domain of x@a.example designates \
             192.0.2.1 as permitted sender) smtp.mailfrom=a.example; \
             dkim=pass (1024-bit key; unprotected) header.d=a.example",
            "x@a.example",
            "mx.example.net",
        );
        assert_eq!(r.methods.len(), 2, "{:?}", r.methods);
        assert_eq!(method(&r, "spf").unwrap().result, MailAuthVerdict::Pass);
        assert_eq!(
            method(&r, "spf").unwrap().identifier.as_deref(),
            Some("a.example")
        );
        assert_eq!(method(&r, "dkim").unwrap().result, MailAuthVerdict::Pass);
    }

    #[test]
    fn nested_and_escaped_comments_do_not_confuse_the_split() {
        let r = trusted(
            r#"mx.example.net; dkim=pass (a (nested (comment) here) \) not-an-end) header.d=a.example; spf=fail"#,
            "x@a.example",
            "mx.example.net",
        );
        assert_eq!(r.methods.len(), 2, "{:?}", r.methods);
        assert_eq!(method(&r, "dkim").unwrap().result, MailAuthVerdict::Pass);
        assert_eq!(method(&r, "spf").unwrap().result, MailAuthVerdict::Fail);
    }

    #[test]
    fn a_comment_does_not_glue_the_tokens_around_it() {
        // `dkim=pass(x)header.d=…` must not become `dkim=passheader.d=…`.
        let r = trusted(
            "mx.example.net; dkim=pass(note)header.d=a.example",
            "x@a.example",
            "mx.example.net",
        );
        let m = method(&r, "dkim").expect("dkim clause");
        assert_eq!(m.result, MailAuthVerdict::Pass);
        assert_eq!(m.identifier.as_deref(), Some("a.example"));
    }

    #[test]
    fn every_result_token_maps_and_unknown_never_becomes_pass() {
        for (tok, want) in [
            ("pass", MailAuthVerdict::Pass),
            ("PASS", MailAuthVerdict::Pass),
            ("fail", MailAuthVerdict::Fail),
            ("softfail", MailAuthVerdict::SoftFail),
            ("neutral", MailAuthVerdict::Neutral),
            ("none", MailAuthVerdict::None),
            ("temperror", MailAuthVerdict::TempError),
            ("permerror", MailAuthVerdict::PermError),
            ("policy", MailAuthVerdict::Policy),
            ("passish", MailAuthVerdict::Unknown),
            ("something-new", MailAuthVerdict::Unknown),
        ] {
            let r = trusted(
                &format!("mx.example.net; spf={tok} smtp.mailfrom=a.example"),
                "x@a.example",
                "mx.example.net",
            );
            assert_eq!(method(&r, "spf").unwrap().result, want, "token {tok}");
        }
    }

    // ── The trust rules, which are the whole point ──────────────────────────

    #[test]
    fn without_a_configured_id_nothing_is_believed() {
        let mut r = parse(
            "mx.example.net; dmarc=pass header.from=a.example",
            "x@a.example",
        );
        apply_trust(&mut r, None);
        assert_eq!(r.state, MailAuthState::Unconfigured);
        assert!(
            r.methods.is_empty(),
            "verdicts must not survive an unchecked header"
        );
    }

    #[test]
    fn an_empty_configured_id_is_not_a_configured_id() {
        let mut r = parse("mx.example.net; dmarc=pass", "x@a.example");
        apply_trust(&mut r, Some("   "));
        assert_eq!(r.state, MailAuthState::Unconfigured);
    }

    /// The forgery this feature exists to survive: the sender writes their own
    /// header, and the receiving server either did not add one or added one
    /// below it in the list this is given.
    #[test]
    fn a_header_from_another_server_is_refused() {
        let mut r = parse(
            "evil.example; spf=pass smtp.mailfrom=bank.example; dmarc=pass header.from=bank.example",
            "security@bank.example",
        );
        apply_trust(&mut r, Some("mx.example.net"));
        assert_eq!(r.state, MailAuthState::Foreign);
        assert!(
            r.methods.is_empty(),
            "a foreign header must show no verdict"
        );
        assert_eq!(r.authserv_id.as_deref(), Some("evil.example"));
    }

    #[test]
    fn only_the_topmost_header_is_read() {
        let values = vec![
            "mx.example.net; dmarc=fail header.from=bank.example".to_string(),
            "evil.example; dmarc=pass header.from=bank.example".to_string(),
        ];
        let mut r = parse_authentication_results(&values, "security@bank.example").unwrap();
        apply_trust(&mut r, Some("mx.example.net"));
        assert_eq!(r.state, MailAuthState::Verified);
        assert_eq!(r.header_count, 2, "the count is disclosed");
        assert_eq!(
            method(&r, "dmarc").unwrap().result,
            MailAuthVerdict::Fail,
            "the lower, forged header must not be the one read"
        );
    }

    /// A forged header *below* the genuine one cannot promote itself by adding
    /// the trusted id — the topmost is still the only one parsed.
    #[test]
    fn a_forged_header_reusing_the_trusted_id_below_is_still_ignored() {
        let values = vec![
            "mx.example.net; dmarc=fail header.from=bank.example".to_string(),
            "mx.example.net; dmarc=pass header.from=bank.example".to_string(),
        ];
        let mut r = parse_authentication_results(&values, "x@bank.example").unwrap();
        apply_trust(&mut r, Some("mx.example.net"));
        assert_eq!(method(&r, "dmarc").unwrap().result, MailAuthVerdict::Fail);
    }

    #[test]
    fn the_id_match_is_equality_not_a_suffix() {
        for forged in [
            "mx.example.net.evil.test",
            "evil-mx.example.net",
            "mx.example.net.",
            "notmx.example.net",
        ] {
            let mut r = parse(&format!("{forged}; dmarc=pass"), "x@a.example");
            apply_trust(&mut r, Some("mx.example.net"));
            assert_eq!(r.state, MailAuthState::Foreign, "{forged} must not match");
        }
        // …but case and surrounding space are not a difference.
        let mut r = parse("  MX.Example.NET ; dmarc=pass", "x@a.example");
        apply_trust(&mut r, Some("mx.example.net"));
        assert_eq!(r.state, MailAuthState::Verified);
    }

    #[test]
    fn a_header_with_no_authserv_id_can_never_be_verified() {
        let mut r = parse("spf=pass smtp.mailfrom=a.example", "x@a.example");
        assert!(r.authserv_id.is_none(), "a clause is not an id");
        apply_trust(&mut r, Some("mx.example.net"));
        assert_eq!(r.state, MailAuthState::Foreign);
    }

    #[test]
    fn an_overlong_header_is_not_parsed_and_cannot_be_verified() {
        let filler = " dkim=pass header.d=a.example;".repeat(500);
        let mut r = parse(&format!("mx.example.net;{filler}"), "x@a.example");
        assert!(r.methods.is_empty());
        assert!(r.authserv_id.is_none());
        apply_trust(&mut r, Some("mx.example.net"));
        assert_eq!(r.state, MailAuthState::Foreign);
    }

    #[test]
    fn the_clause_count_is_bounded() {
        let clauses = (0..100)
            .map(|i| format!(" x{i}=pass"))
            .collect::<Vec<_>>()
            .join(";");
        let r = trusted(
            &format!("mx.example.net;{clauses}"),
            "x@a.example",
            "mx.example.net",
        );
        assert!(r.methods.len() <= MAX_METHODS, "{}", r.methods.len());
    }

    // ── Alignment: a pass by the wrong domain ───────────────────────────────

    #[test]
    fn a_pass_by_a_different_domain_is_reported_as_unaligned() {
        let r = trusted(
            "mx.example.net; dkim=pass header.d=evil.example; \
             spf=pass smtp.mailfrom=bounce.evil.example",
            "security@bank.example",
            "mx.example.net",
        );
        assert_eq!(method(&r, "dkim").unwrap().result, MailAuthVerdict::Pass);
        assert_eq!(
            method(&r, "dkim").unwrap().aligned,
            Some(false),
            "a pass for evil.example on a mail claiming bank.example is not alignment"
        );
        assert_eq!(method(&r, "spf").unwrap().aligned, Some(false));
    }

    #[test]
    fn a_subdomain_counts_as_aligned() {
        let r = trusted(
            "mx.example.net; dkim=pass header.d=mail.bank.example",
            "security@bank.example",
            "mx.example.net",
        );
        assert_eq!(method(&r, "dkim").unwrap().aligned, Some(true));
    }

    #[test]
    fn a_clause_that_names_no_identity_reports_unknown_alignment() {
        let r = trusted("mx.example.net; dkim=fail", "x@a.example", "mx.example.net");
        let m = method(&r, "dkim").unwrap();
        assert!(m.identifier.is_none());
        assert_eq!(m.aligned, None, "unknown must not be reported as aligned");
    }

    #[test]
    fn header_i_is_used_when_header_d_is_absent_and_is_reduced_to_its_domain() {
        let r = trusted(
            "mx.example.net; dkim=pass header.i=@a.example",
            "x@a.example",
            "mx.example.net",
        );
        assert_eq!(
            method(&r, "dkim").unwrap().identifier.as_deref(),
            Some("a.example")
        );
    }

    #[test]
    fn header_d_wins_over_header_i_whatever_order_they_appear_in() {
        for header in [
            "mx.example.net; dkim=pass header.i=@i.example header.d=d.example",
            "mx.example.net; dkim=pass header.d=d.example header.i=@i.example",
        ] {
            let r = trusted(header, "x@d.example", "mx.example.net");
            assert_eq!(
                method(&r, "dkim").unwrap().identifier.as_deref(),
                Some("d.example"),
                "{header}"
            );
        }
    }

    #[test]
    fn spf_falls_back_to_helo_when_there_is_no_envelope_sender() {
        let r = trusted(
            "mx.example.net; spf=pass smtp.helo=mail.a.example",
            "x@a.example",
            "mx.example.net",
        );
        assert_eq!(
            method(&r, "spf").unwrap().identifier.as_deref(),
            Some("mail.a.example")
        );
    }

    #[test]
    fn a_versioned_method_keeps_its_name() {
        let r = trusted(
            "mx.example.net 1; dkim/1=pass header.d=a.example",
            "x@a.example",
            "mx.example.net",
        );
        assert_eq!(r.authserv_id.as_deref(), Some("mx.example.net"));
        assert!(method(&r, "dkim").is_some(), "{:?}", r.methods);
    }

    #[test]
    fn the_no_result_form_yields_no_methods() {
        let r = trusted("mx.example.net; none", "x@a.example", "mx.example.net");
        assert_eq!(r.state, MailAuthState::Verified);
        assert!(r.methods.is_empty(), "{:?}", r.methods);
    }

    /// Whatever bytes a sender sends, parsing returns and never panics.
    #[test]
    fn parsing_is_total() {
        // Grouped to read as "ALICE SEED", not in even nibble groups.
        #[allow(clippy::unusual_byte_groupings)]
        let mut seed: u64 = 0xA11CE_5EED_0001;
        for _ in 0..5_000 {
            let len = {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                (seed >> 33) as usize % 200
            };
            let mut bytes = Vec::with_capacity(len);
            for _ in 0..len {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                // Skew towards the structural characters, which is where the
                // interesting states are.
                let b = (seed >> 24) as u8;
                bytes.push(match b % 8 {
                    0 => b'(',
                    1 => b')',
                    2 => b';',
                    3 => b'=',
                    4 => b'"',
                    5 => b'\\',
                    _ => b,
                });
            }
            let input = String::from_utf8_lossy(&bytes).to_string();
            let mut r = parse_authentication_results(&[input], "x@a.example").unwrap();
            apply_trust(&mut r, Some("mx.example.net"));
            assert!(r.methods.len() <= MAX_METHODS);
            // Random bytes must essentially never produce a trusted verdict.
            if r.state == MailAuthState::Verified {
                assert_eq!(
                    r.authserv_id.as_deref().map(str::trim),
                    Some("mx.example.net")
                );
            }
        }
    }
}
